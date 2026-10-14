import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, appointments, hmoAuthorizations, hmoClaims } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createDoctor, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

// Test FX: a $10 package costs ₦7,500 for a Nigerian patient.
const STANDARD = 7_500;
const PASSWORD = 'Temp-pass-123';
const NEW_PASSWORD = 'My-own-pass-456';

let adminToken: string;
let packageId: string;
let outbox: OutgoingMail[];

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const admin = {
  get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(adminToken)),
  post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
};
const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set(auth(token)),
  post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(auth(token)).send(b),
  patch: (p: string, b: object = {}) => api().patch(`/api/v1${p}`).set(auth(token)).send(b),
});

/** An HMO whose Gold plan covers consultations with the given rule; one member who uses the app. */
async function memberOf(rule: object) {
  const hmo = await admin.post('/hmos', { name: 'Avon Healthcare HMO', code: 'avon', contactEmail: 'claims@avon.example' });
  expect(hmo.status).toBe(201);
  const plan = await admin.post(`/hmos/${hmo.body.id}/plans`, { name: 'Gold' });
  const planId = plan.body.plans[0].id as string;
  const created = await admin.post(`/hmos/${hmo.body.id}/plans/${planId}/rules`, { service: 'consultation', ...rule });
  expect(created.status).toBe(201);
  const email = 'ada@patient.test';
  const patient = await createUser({ email, country: 'NG', currency: 'NGN', firstName: 'Ada', lastName: 'Obi' });
  const enrolled = await admin.post(`/hmos/${hmo.body.id}/enrollees`, { planId, enrolleeCode: 'AVN-001', lastName: 'Obi', email });
  expect(enrolled.body.userId).toBe(patient.id);
  return { hmoId: hmo.body.id as string, patient };
}

const book = (token: string, key: string) =>
  api().post('/api/v1/appointments').set(auth(token)).set('Idempotency-Key', key).send({ packageId, startTime: inHours(3) });

async function listedPackage(token: string) {
  const res = await as(token).get('/appointments/packages');
  const items = res.body.items ?? res.body;
  return items.find((p: { id: string }) => p.id === packageId);
}

/** A portal account that has already chosen its own password. */
async function portalUser(hmoId: string, role: 'manager' | 'viewer') {
  const email = `${role}-${newId()}@hmo.test`;
  const created = await admin.post(`/hmos/${hmoId}/users`, { name: 'Portal Person', email, role, password: PASSWORD });
  expect(created.status).toBe(201);
  const login = await api().post('/api/v1/hmo-portal/auth/login').send({ email, password: PASSWORD });
  const changed = await as(login.body.session.accessToken).patch('/hmo-portal/password', {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
  });
  expect(changed.status).toBe(200);
  return changed.body.session.accessToken as string;
}

beforeEach(async () => {
  await resetDatabase();
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
  packageId = await createPackage({ name: 'GP' });
  outbox = [];
  setMailSink(async (mail) => {
    outbox.push(mail);
  });
});
afterEach(() => setMailSink(undefined));

describe('HMO pre-authorisation', () => {
  it('above the threshold the member asks first; the HMO approves with a PA code that the next booking uses', async () => {
    const { hmoId, patient } = await memberOf({ coverage: 'full', hmoAmount: 6_000, authorizationAbove: 5_000 });

    // Without approval: normal price, with a notice saying what to do.
    const listed = await listedPackage(patient.token);
    expect(listed.hmo).toMatchObject({
      covered: false,
      notice: 'authorization_required',
      authorization: { service: 'consultation', packageId, amount: 6_000, pendingRequestId: null },
    });
    expect(listed.hmo.message).toMatch(/approv/i);
    const unapproved = await book(patient.token, 'pa-before');
    const [paying] = await db.select().from(appointments).where(eq(appointments.id, unapproved.body.id));
    expect(paying).toMatchObject({ hmoClaimId: null, isPaid: false, price: STANDARD });
    await db.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, paying!.id));

    // The request goes to the HMO; asking twice returns the same request.
    const asked = await as(patient.token).post('/hmo/authorizations', { service: 'consultation', packageId, note: 'Recurring chest pain' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'pending', requestedAmount: 6_000, code: null });
    const again = await as(patient.token).post('/hmo/authorizations', { service: 'consultation', packageId });
    expect(again.body.id).toBe(asked.body.id);
    await settle();
    expect(outbox.filter((m) => m.to === 'claims@avon.example' && m.category === 'hmo-authorization-requested')).toHaveLength(1);
    expect((await listedPackage(patient.token)).hmo).toMatchObject({
      notice: 'authorization_pending',
      authorization: { pendingRequestId: asked.body.id },
    });

    // A viewer can see it but not decide; a manager approves.
    const viewer = await portalUser(hmoId, 'viewer');
    const queue = await as(viewer).get('/hmo-portal/authorizations?status=pending');
    expect(queue.body).toMatchObject({ total: 1, pending: 1 });
    expect(queue.body.items[0]).toMatchObject({ id: asked.body.id, enrolleeCode: 'AVN-001', patientNote: 'Recurring chest pain' });
    expect((await as(viewer).post(`/hmo-portal/authorizations/${asked.body.id}/decision`, { action: 'approve' })).status).toBe(403);
    const manager = await portalUser(hmoId, 'manager');
    const approved = await as(manager).post(`/hmo-portal/authorizations/${asked.body.id}/decision`, {
      action: 'approve',
      hmoReference: 'AVN-PA-7781',
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', approvedAmount: 6_000, hmoReference: 'AVN-PA-7781' });
    const code = approved.body.code as string;
    expect(code).toMatch(/^PA-AVON-[A-Z0-9]{6}$/);
    expect(new Date(approved.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 3600_000);
    const twice = await as(manager).post(`/hmo-portal/authorizations/${asked.body.id}/decision`, { action: 'reject', note: 'Changed mind' });
    expect(twice.status).toBe(409);

    // The member sees the code; the next booking is covered and carries it.
    const mine = await as(patient.token).get('/hmo/authorizations');
    expect(mine.body.items[0]).toMatchObject({ status: 'approved', code });
    expect((await listedPackage(patient.token)).hmo).toMatchObject({ covered: true, authorizationCode: code });
    const covered = await book(patient.token, 'pa-after');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, covered.body.id));
    expect(appt).toMatchObject({ price: 0, isPaid: true });
    const [claim] = await db.select().from(hmoClaims).where(eq(hmoClaims.id, appt!.hmoClaimId!));
    expect(claim).toMatchObject({ hmoAmount: 6_000, authorizationCode: code });
    const [used] = await db.select().from(hmoAuthorizations).where(eq(hmoAuthorizations.id, asked.body.id));
    expect(used).toMatchObject({ status: 'used', claimId: claim!.id });

    // One approval, one use.
    const another = await book(patient.token, 'pa-again');
    const [second] = await db.select().from(appointments).where(eq(appointments.id, another.body.id));
    expect(second).toMatchObject({ hmoClaimId: null, isPaid: false });
    await db.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, second!.id));

    // The claim shows the PA code to the HMO.
    const claims = await as(manager).get('/hmo-portal/claims');
    expect(claims.body.items[0]).toMatchObject({ authorizationCode: code });

    // A cancelled visit gives the approval back.
    await db.update(appointments).set({ status: 'cancelled' }).where(eq(appointments.id, appt!.id));
    const rebooked = await book(patient.token, 'pa-rebook');
    const [reused] = await db.select().from(appointments).where(eq(appointments.id, rebooked.body.id));
    expect(reused!.hmoClaimId).not.toBeNull();
    const [reclaim] = await db.select().from(hmoClaims).where(eq(hmoClaims.id, reused!.hmoClaimId!));
    expect(reclaim!.authorizationCode).toBe(code);
  });

  it('the doctor sees the patient is an HMO member and the PA code on the appointment', async () => {
    const { hmoId, patient } = await memberOf({ coverage: 'full', hmoAmount: 6_000, authorizationAbove: 0 });
    const asked = await as(patient.token).post('/hmo/authorizations', { service: 'consultation', packageId });
    const approved = await admin.post(`/hmos/${hmoId}/authorizations/${asked.body.id}/decision`, { action: 'approve', validDays: 3 });
    expect(approved.status).toBe(200);
    const booked = await book(patient.token, 'pa-doctor');
    const doctor = await createDoctor();
    await db.update(appointments).set({ doctorId: doctor.id }).where(eq(appointments.id, booked.body.id));

    const seen = await as(doctor.token).get(`/appointments/${booked.body.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.hmo).toMatchObject({
      name: 'Avon Healthcare HMO',
      planName: 'Gold',
      enrolleeCode: 'AVN-001',
      authorizationCode: approved.body.code,
    });

    // A private patient has no HMO block.
    const other = await createUser({ email: 'private@patient.test', country: 'NG', currency: 'NGN' });
    const own = await book(other.token, 'private-1');
    expect((await as(other.token).get(`/appointments/${own.body.id}`)).body.hmo).toBeNull();
  });

  it('a declined request tells the member why and leaves the normal price', async () => {
    const { hmoId, patient } = await memberOf({ coverage: 'full', authorizationAbove: 0 });
    const asked = await as(patient.token).post('/hmo/authorizations', { service: 'consultation', packageId });
    expect((await admin.post(`/hmos/${hmoId}/authorizations/${asked.body.id}/decision`, { action: 'reject' })).status).toBe(400);
    const declined = await admin.post(`/hmos/${hmoId}/authorizations/${asked.body.id}/decision`, {
      action: 'reject',
      note: 'Please see your primary provider first',
    });
    expect(declined.body).toMatchObject({ status: 'rejected', code: null, decisionNote: 'Please see your primary provider first' });
    expect((await listedPackage(patient.token)).hmo).toMatchObject({ covered: false, notice: 'authorization_required' });
    const list = await admin.get(`/hmos/${hmoId}/authorizations?status=rejected`);
    expect(list.body.total).toBe(1);
  });

  it('no approval needed under the threshold; a waiting request can be withdrawn', async () => {
    const { patient } = await memberOf({ coverage: 'full', hmoAmount: 4_000, authorizationAbove: 5_000 });
    const res = await as(patient.token).post('/hmo/authorizations', { service: 'consultation', packageId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('APPROVAL_NOT_NEEDED');
    expect((await listedPackage(patient.token)).hmo).toMatchObject({ covered: true });

    await resetDatabase();
    packageId = await createPackage({ name: 'GP' });
    const adminId = newId();
    await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
    adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
    const second = await memberOf({ coverage: 'full', authorizationAbove: 0 });
    const asked = await as(second.patient.token).post('/hmo/authorizations', { service: 'consultation', packageId });
    const withdrawn = await as(second.patient.token).post(`/hmo/authorizations/${asked.body.id}/cancel`);
    expect(withdrawn.body.status).toBe('cancelled');
    expect((await as(second.patient.token).post(`/hmo/authorizations/${asked.body.id}/cancel`)).status).toBe(400);
  });

  it('a naira allowance on consultations: the HMO pays up to what is left, the member the rest', async () => {
    const { patient } = await memberOf({ coverage: 'full', hmoAmount: 6_000, limitAmount: 10_000, limitPeriod: 'month' });
    expect((await listedPackage(patient.token)).hmo).toMatchObject({ covered: true, allowance: expect.anything() });
    const first = await book(patient.token, 'allowance-1');
    const [a] = await db.select().from(appointments).where(eq(appointments.id, first.body.id));
    expect(a!.hmoClaimId).not.toBeNull();
    const second = await book(patient.token, 'allowance-2');
    const [b] = await db.select().from(appointments).where(eq(appointments.id, second.body.id));
    // ₦4,000 left: the HMO pays that and the member the rest of the ₦6,000 tariff.
    expect(b).toMatchObject({ isPaid: false, price: 2_000 });
    const [split] = await db.select().from(hmoClaims).where(eq(hmoClaims.id, b!.hmoClaimId!));
    expect(split).toMatchObject({ hmoAmount: 4_000, patientAmount: 2_000 });
  });
});
