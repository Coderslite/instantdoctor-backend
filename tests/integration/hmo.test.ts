import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import {
  admins,
  appointments,
  hmoClaims,
  hmoEnrollees,
  hmoLinkRequests,
  labResults,
  serviceCharges,
} from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { confirmAppointment } from '../../src/modules/payments/fulfillment.js';
import { api, auth, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

// Test FX: ₦1,500 = $1, with the 50% regional discount → a $10 package costs ₦7,500, a $4 lab review ₦3,000.
const STANDARD = 7_500;
const LAB_STANDARD = 3_000;

let adminToken: string;
let packageId: string;

async function adminOf(role: 'admin' | 'marketer' = 'admin') {
  const id = newId();
  await db.insert(admins).values({ id, name: 'Ops', email: `${id}@admin.test`, role });
  return signAdminAccessToken({ sub: id, role });
}
const admin = {
  get: (p: string) => api().get(p).set(auth(adminToken)),
  post: (p: string, b: object = {}) => api().post(p).set(auth(adminToken)).send(b),
  patch: (p: string, b: object = {}) => api().patch(p).set(auth(adminToken)).send(b),
};
const as = (token: string) => ({
  get: (p: string) => api().get(p).set(auth(token)),
  post: (p: string, b: object = {}) => api().post(p).set(auth(token)).send(b),
});

/** An HMO with one plan and the given rules; returns ids. */
async function agreement(rules: object[]) {
  const hmo = await api()
    .post('/api/v1/admin/hmos')
    .set(auth(adminToken))
    .send({ name: 'Avon Healthcare HMO', code: 'avon', contactEmail: 'claims@avon.example' });
  expect(hmo.status).toBe(201);
  const withPlan = await api()
    .post(`/api/v1/admin/hmos/${hmo.body.id}/plans`)
    .set(auth(adminToken))
    .send({ name: 'Gold' });
  const planId = withPlan.body.plans[0].id;
  for (const rule of rules) {
    const res = await api()
      .post(`/api/v1/admin/hmos/${hmo.body.id}/plans/${planId}/rules`)
      .set(auth(adminToken))
      .send(rule);
    expect(res.status).toBe(201);
  }
  return { hmoId: hmo.body.id as string, planId: planId as string };
}

/** A Nigerian patient already on the HMO's list (matched automatically by email). */
async function member(hmoId: string, planId: string, code = 'AVN-001') {
  const email = `${code.toLowerCase()}@patient.test`;
  const user = await createUser({
    email,
    country: 'NG',
    currency: 'NGN',
    lastName: 'Okafor',
    phoneNumber: '+2348031234567',
  });
  const res = await api()
    .post(`/api/v1/admin/hmos/${hmoId}/enrollees`)
    .set(auth(adminToken))
    .send({ planId, enrolleeCode: code, lastName: 'Okafor', email });
  expect(res.status).toBe(201);
  expect(res.body.userId).toBe(user.id); // matched at once
  return user;
}

const book = (token: string, key: string) =>
  api()
    .post('/api/v1/appointments')
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send({ packageId, startTime: inHours(3) });

beforeEach(async () => {
  await resetDatabase();
  adminToken = await adminOf();
  packageId = await createPackage({ name: 'GP' });
  await db
    .insert(serviceCharges)
    .values({ id: newId(), type: 'LapResult', name: 'Lab interpretation', amountUsd: 4 });
});

describe('HMO coverage at booking', () => {
  it('fully covered: ₦0 for the patient, confirmed at once, HMO billed, doctor paid on the HMO tariff', async () => {
    const { hmoId, planId } = await agreement([
      { service: 'consultation', coverage: 'full', hmoAmount: 6_000 },
    ]);
    const patient = await member(hmoId, planId);

    const packages = await as(patient.token).get('/api/v1/appointments/packages');
    const listed =
      packages.body.items?.find?.((p: { id: string }) => p.id === packageId) ??
      packages.body.find((p: { id: string }) => p.id === packageId);
    expect(listed.price).toMatchObject({ amount: 0, currency: 'NGN' });
    expect(listed.hmo).toMatchObject({
      covered: true,
      hmoName: 'Avon Healthcare HMO',
      summary: 'Fully covered',
      standardPrice: STANDARD,
    });

    const res = await book(patient.token, 'hmo-full-1');
    expect(res.status).toBe(201);
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, res.body.id));
    expect(appt).toMatchObject({ price: 0, currency: 'NGN', isPaid: true, doctorEarning: 3_600 });
    const [claim] = await db
      .select()
      .from(hmoClaims)
      .where(eq(hmoClaims.appointmentId, res.body.id));
    expect(claim).toMatchObject({
      id: appt!.hmoClaimId,
      hmoId,
      enrolleeCode: 'AVN-001',
      standardAmount: STANDARD,
      patientAmount: 0,
      hmoAmount: 6_000,
      status: 'unbilled',
    });
  });

  it('co-pay: the patient pays the co-pay, and the doctor still earns the agreed fee after payment', async () => {
    const { hmoId, planId } = await agreement([
      {
        service: 'consultation',
        coverage: 'copay_fixed',
        patientAmount: 1_000,
        hmoAmount: 5_000,
        doctorEarning: 3_500,
      },
    ]);
    const patient = await member(hmoId, planId);
    const res = await book(patient.token, 'hmo-copay-1');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, res.body.id));
    expect(appt).toMatchObject({
      price: 1_000,
      currency: 'NGN',
      isPaid: false,
      doctorEarning: 3_500,
    });

    await db.transaction((tx) => confirmAppointment(tx, appt!.id)); // what a successful payment does
    const [paid] = await db.select().from(appointments).where(eq(appointments.id, appt!.id));
    expect(paid).toMatchObject({ isPaid: true, doctorEarning: 3_500 }); // not 60% of the ₦1,000 co-pay
  });

  it('package rules beat the plan-wide rule, and "not covered" means the normal price', async () => {
    const specialist = await createPackage({ name: 'Specialist', amountUsd: 20 });
    const { hmoId, planId } = await agreement([
      { service: 'consultation', coverage: 'discount_percent', percent: 20 },
      { service: 'consultation', packageId: specialist, coverage: 'not_covered' },
    ]);
    const patient = await member(hmoId, planId);
    const res = await as(patient.token).get('/api/v1/appointments/packages');
    const list = (res.body.items ?? res.body) as Array<{
      id: string;
      price: { amount: number };
      hmo: { covered: boolean; notice?: string };
    }>;
    expect(list.find((p) => p.id === packageId)).toMatchObject({
      price: { amount: 6_000 },
      hmo: { covered: true },
    });
    expect(list.find((p) => p.id === specialist)).toMatchObject({
      hmo: { covered: false, notice: 'not_covered' },
    });
  });

  it('usage limits: past the limit it is the normal price, or blocked when the agreement says so', async () => {
    const { hmoId, planId } = await agreement([
      { service: 'consultation', coverage: 'full', limitCount: 1, limitPeriod: 'month' },
    ]);
    const patient = await member(hmoId, planId);
    expect((await book(patient.token, 'hmo-limit-1')).status).toBe(201);

    const second = await book(patient.token, 'hmo-limit-2');
    expect(second.status).toBe(201);
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, second.body.id));
    expect(appt).toMatchObject({ hmoClaimId: null, isPaid: false });
    expect(appt!.price).toBeGreaterThan(0);

    // A cancelled covered visit gives the use back.
    await db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(eq(appointments.hmoClaimId, (await db.select().from(hmoClaims))[0]!.id));
    const third = await book(patient.token, 'hmo-limit-3');
    const [covered] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, third.body.id));
    expect(covered!.hmoClaimId).not.toBeNull();
  });

  it('blocks past the limit when the agreement forbids out-of-pocket bookings', async () => {
    const { hmoId, planId } = await agreement([
      {
        service: 'consultation',
        coverage: 'full',
        limitCount: 1,
        limitPeriod: 'year',
        overLimit: 'block',
      },
    ]);
    const patient = await member(hmoId, planId);
    await book(patient.token, 'hmo-block-1');
    const res = await book(patient.token, 'hmo-block-2');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HMO_LIMIT_REACHED');
  });

  it('stops covering when the membership, plan or HMO is no longer active', async () => {
    const { hmoId, planId } = await agreement([{ service: 'consultation', coverage: 'full' }]);
    const patient = await member(hmoId, planId);
    await api()
      .patch(`/api/v1/admin/hmos/${hmoId}`)
      .set(auth(adminToken))
      .send({ status: 'paused' });
    const res = await book(patient.token, 'hmo-paused-1');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, res.body.id));
    expect(appt!.hmoClaimId).toBeNull();
    expect((await as(patient.token).get('/api/v1/hmo/me')).body).toMatchObject({
      membership: null,
      inactive: { hmoName: 'Avon Healthcare HMO' },
    });
  });

  it('prices lab interpretation by the agreement too', async () => {
    const { hmoId, planId } = await agreement([
      { service: 'lab_interpretation', coverage: 'discount_percent', percent: 50 },
    ]);
    const patient = await member(hmoId, planId);
    const price = await as(patient.token).get('/api/v1/lab-results/price');
    expect(price.body).toMatchObject({
      amount: LAB_STANDARD / 2,
      currency: 'NGN',
      hmo: { covered: true, standardPrice: LAB_STANDARD },
    });
    const created = await api()
      .post('/api/v1/lab-results')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'hmo-lab-1')
      .send({ files: [{ fileUrl: 'https://files.example/result.pdf', fileType: 'File' }] });
    expect(created.status).toBe(201);
    const [lab] = await db.select().from(labResults).where(eq(labResults.id, created.body.id));
    expect(lab).toMatchObject({ price: 1_500, currency: 'NGN', status: 'awaiting_payment' });
    const [claim] = await db.select().from(hmoClaims).where(eq(hmoClaims.labResultId, lab!.id));
    expect(claim).toMatchObject({
      service: 'lab_interpretation',
      patientAmount: 1_500,
      hmoAmount: 0,
    });
  });
});

describe('Link my HMO', () => {
  it('links when the code and a detail match, queues for review when they do not', async () => {
    const { hmoId, planId } = await agreement([{ service: 'consultation', coverage: 'full' }]);
    await api()
      .post(`/api/v1/admin/hmos/${hmoId}/enrollees`)
      .set(auth(adminToken))
      .send({ planId, enrolleeCode: 'avn-777', lastName: 'Bello', dateOfBirth: '1990-04-23' });
    const patient = await createUser({ country: 'NG', currency: 'NGN' });

    expect((await as(patient.token).get('/api/v1/hmo/partners')).body.items).toEqual([
      expect.objectContaining({ id: hmoId, name: 'Avon Healthcare HMO' }),
    ]);

    const wrong = await as(patient.token).post('/api/v1/hmo/link', {
      hmoId,
      enrolleeCode: 'AVN-777',
      lastName: 'Adeyemi',
    });
    expect(wrong.status).toBe(202);
    expect(wrong.body.status).toBe('pending_review');
    expect(await db.select().from(hmoLinkRequests)).toEqual([
      expect.objectContaining({ reason: 'no_match', status: 'pending' }),
    ]);

    const right = await as(patient.token).post('/api/v1/hmo/link', {
      hmoId,
      enrolleeCode: 'avn-777',
      dateOfBirth: '1990-04-23',
    });
    expect(right.status).toBe(200);
    expect(right.body.coverage.membership).toMatchObject({
      enrolleeCode: 'AVN-777',
      hmo: { name: 'Avon Healthcare HMO' },
      benefits: [expect.objectContaining({ summary: 'Fully covered' })],
    });

    const someoneElse = await createUser({ country: 'NG' });
    const taken = await as(someoneElse.token).post('/api/v1/hmo/link', {
      hmoId,
      enrolleeCode: 'AVN-777',
      lastName: 'bello',
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('ENROLLEE_ALREADY_LINKED');
  });

  it('lets an admin approve a request, and never re-links someone who unlinked', async () => {
    const { hmoId, planId } = await agreement([{ service: 'consultation', coverage: 'full' }]);
    const patient = await member(hmoId, planId, 'AVN-500');
    expect((await api().delete('/api/v1/hmo/me').set(auth(patient.token))).status).toBe(200);
    expect((await as(patient.token).get('/api/v1/hmo/me')).body.membership).toBeNull(); // no silent re-match by email

    await as(patient.token).post('/api/v1/hmo/link', {
      hmoId,
      enrolleeCode: 'AVN-500',
      lastName: 'Wrong',
    });
    const queue = await admin.get('/api/v1/admin/hmo-link-requests');
    expect(queue.body.items).toHaveLength(1);
    const [enrollee] = await db
      .select()
      .from(hmoEnrollees)
      .where(eq(hmoEnrollees.enrolleeCode, 'AVN-500'));
    const approved = await admin.post(
      `/api/v1/admin/hmo-link-requests/${queue.body.items[0].id}/approve`,
      { enrolleeId: enrollee!.id },
    );
    expect(approved.status).toBe(200);
    expect((await as(patient.token).get('/api/v1/hmo/me')).body.membership).toMatchObject({
      enrolleeCode: 'AVN-500',
    });
  });
});

describe('Rosters, claims and invoices', () => {
  it('imports a member list, reports bad rows and ends members missing from a full list', async () => {
    const { hmoId, planId } = await agreement([{ service: 'consultation', coverage: 'full' }]);
    await api()
      .post(`/api/v1/admin/hmos/${hmoId}/enrollees`)
      .set(auth(adminToken))
      .send({ planId, enrolleeCode: 'OLD-1' });
    const existing = await createUser({ email: 'ngozi@patient.test', country: 'NG' });
    const res = await admin.post(`/api/v1/admin/hmos/${hmoId}/enrollees/import`, {
      planId,
      endMissing: true,
      rows: [
        {
          enrolleeCode: 'NEW-1',
          firstName: 'Ngozi',
          lastName: 'Eze',
          email: 'NGOZI@patient.test',
          dateOfBirth: '23/04/1990',
        },
        { enrolleeCode: 'NEW-2', phone: '0803 123 4567', dateOfBirth: 'someday' },
        { enrolleeCode: 'new-1', lastName: 'Duplicate' },
      ],
    });
    expect(res.body).toMatchObject({ created: 2, updated: 0, ended: 1, matched: 1 });
    expect(res.body.errors.map((e: { message: string }) => e.message)).toEqual([
      expect.stringContaining('Unreadable date of birth'),
      'Duplicate enrollee code in the file',
    ]);
    const rows = await db.select().from(hmoEnrollees);
    expect(rows.find((r) => r.enrolleeCode === 'NEW-1')).toMatchObject({
      userId: existing.id,
      dateOfBirth: '1990-04-23',
      email: 'ngozi@patient.test',
    });
    expect(rows.find((r) => r.enrolleeCode === 'NEW-2')!.phone).toBe('+2348031234567');
    expect(rows.find((r) => r.enrolleeCode === 'OLD-1')!.status).toBe('ended');
  });

  it('invoices only billable claims, then settles or releases them', async () => {
    const { hmoId, planId } = await agreement([
      { service: 'consultation', coverage: 'copay_fixed', patientAmount: 500, hmoAmount: 5_000 },
    ]);
    const patient = await member(hmoId, planId);
    const paid = await book(patient.token, 'hmo-invoice-1');
    const unpaid = await book(patient.token, 'hmo-invoice-2');
    await db.transaction((tx) => confirmAppointment(tx, paid.body.id));
    expect(unpaid.status).toBe(201);

    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const invoice = await admin.post(`/api/v1/admin/hmos/${hmoId}/invoices`, {
      periodStart: today,
      periodEnd: later,
    });
    expect(invoice.status).toBe(201);
    expect(invoice.body).toMatchObject({
      reference: expect.stringMatching(/^INV\/AVON\/\d{4}\/\d{2}\/0001$/),
      claimCount: 1,
      totalAmount: 5_000,
      status: 'issued',
    });

    const again = await admin.post(`/api/v1/admin/hmos/${hmoId}/invoices`, {
      periodStart: today,
      periodEnd: later,
    });
    expect(again.body.error.code).toBe('NOTHING_TO_INVOICE'); // the unpaid booking is not billable

    const settled = await admin.patch(`/api/v1/admin/hmos/${hmoId}/invoices/${invoice.body.id}`, {
      status: 'paid',
      paymentReference: 'TRF-889',
    });
    expect(settled.body).toMatchObject({
      status: 'paid',
      paymentReference: 'TRF-889',
      claims: [expect.objectContaining({ status: 'paid' })],
    });

    const claims = await admin.get(`/api/v1/admin/hmos/${hmoId}/claims`);
    expect(claims.body.totals.paid).toMatchObject({ claims: 1, amount: 5_000 });
  });

  it('keeps agreements in the admins’ hands', async () => {
    const marketer = await adminOf('marketer');
    expect(
      (
        await api()
          .post('/api/v1/admin/hmos')
          .set(auth(marketer))
          .send({ name: 'X HMO', code: 'XH' })
      ).status,
    ).toBe(403);
    expect((await api().get('/api/v1/admin/hmos')).status).toBe(401);
    const { hmoId, planId } = await agreement([]);
    const bad = await admin.post(`/api/v1/admin/hmos/${hmoId}/plans/${planId}/rules`, {
      service: 'consultation',
      coverage: 'copay_fixed',
    });
    expect(bad.status).toBe(400);
    await admin.post(`/api/v1/admin/hmos/${hmoId}/plans/${planId}/rules`, {
      service: 'consultation',
      coverage: 'full',
    });
    const clash = await admin.post(`/api/v1/admin/hmos/${hmoId}/plans/${planId}/rules`, {
      service: 'consultation',
      coverage: 'discount_percent',
      percent: 10,
    });
    expect(clash.body.error.code).toBe('HMO_RULE_EXISTS');
    const preview = await admin.get(`/api/v1/admin/hmos/${hmoId}/plans/${planId}/price-preview`);
    expect(preview.body.consultations[0]).toMatchObject({
      standardAmount: STANDARD,
      patientAmount: 0,
      hmoAmount: STANDARD,
      covered: true,
    });
    expect(preview.body.labInterpretation).toMatchObject({
      covered: false,
      patientAmount: LAB_STANDARD,
    });
  });
});
