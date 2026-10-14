import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, appointments, hmoClaims, hmoEnrollees } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { monthOf } from '../../src/modules/hmo/hmo.capitation.js';
import { api, auth, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

let adminToken: string;
let packageId: string;

const admin = {
  get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(adminToken)),
  post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
  patch: (p: string, b: object = {}) => api().patch(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
};

const DAY = 24 * 3600_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
/** Today and the 1st of this month, as Lagos dates. */
const thisMonth = monthOf(new Date());
const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const firstOfMonth = `${thisMonth}-01`;
/** The visit is booked 3 hours ahead, which late in the evening is tomorrow in Lagos: bill up to the visit's day. */
const visitDay = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const billedTo = visitDay.startsWith(thisMonth) ? visitDay : today;

/** A capitation plan at ₦500 per member per month whose consultations are capitated (doctor paid ₦2,000). */
async function capitationAgreement() {
  const hmo = await admin.post('/hmos', { name: 'Avon Healthcare HMO', code: 'avon' });
  const plan = await admin.post(`/hmos/${hmo.body.id}/plans`, {
    name: 'Gold',
    paymentModel: 'capitation',
    capitationRate: 500,
  });
  expect(plan.status).toBe(201);
  const planId = plan.body.plans[0].id as string;
  const rule = await admin.post(`/hmos/${hmo.body.id}/plans/${planId}/rules`, {
    service: 'consultation',
    coverage: 'full',
    billing: 'capitation',
    doctorEarning: 2_000,
  });
  expect(rule.status).toBe(201);
  return { hmoId: hmo.body.id as string, planId };
}

async function enrol(hmoId: string, planId: string, code: string, extra: object = {}) {
  const res = await admin.post(`/hmos/${hmoId}/enrollees`, { planId, enrolleeCode: code, ...extra });
  expect(res.status).toBe(201);
  return res.body.id as string;
}
const backdate = (id: string, values: Partial<typeof hmoEnrollees.$inferInsert>) =>
  db.update(hmoEnrollees).set({ createdAt: daysAgo(70), ...values }).where(eq(hmoEnrollees.id, id));

beforeEach(async () => {
  await resetDatabase();
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
  packageId = await createPackage({ name: 'GP' });
});

describe('HMO capitation', () => {
  it('bills members active on the 1st × rate, records capitated visits as ₦0 encounters and pays the doctor the fixed fee', async () => {
    const { hmoId, planId } = await capitationAgreement();
    const email = 'ada@patient.test';
    const patient = await createUser({ email, country: 'NG', currency: 'NGN' });
    // Counted: on the list since before the 1st (one of them ended after the 1st).
    await backdate(await enrol(hmoId, planId, 'AVN-001', { email }), {});
    await backdate(await enrol(hmoId, planId, 'AVN-002'), { status: 'ended', deactivatedAt: new Date() });
    // Not counted: joined this month, ended before the 1st, or cover ran out before the 1st.
    if (today !== firstOfMonth) await enrol(hmoId, planId, 'AVN-003');
    await backdate(await enrol(hmoId, planId, 'AVN-004'), { status: 'ended', deactivatedAt: daysAgo(40) });
    await backdate(await enrol(hmoId, planId, 'AVN-005'), { validTo: daysAgo(40) });

    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'capitated-visit-1')
      .send({ packageId, startTime: inHours(3) });
    expect(booked.status).toBe(201);
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, booked.body.id));
    expect(appt).toMatchObject({ price: 0, isPaid: true, doctorEarning: 2_000 });
    const [encounter] = await db.select().from(hmoClaims).where(eq(hmoClaims.appointmentId, appt!.id));
    expect(encounter).toMatchObject({ billing: 'capitation', hmoAmount: 0, patientAmount: 0 });

    const invoice = await admin.post(`/hmos/${hmoId}/invoices`, { periodStart: firstOfMonth, periodEnd: billedTo });
    expect(invoice.status).toBe(201);
    expect(invoice.body).toMatchObject({ capitationAmount: 1_000, totalAmount: 1_000, claimCount: 1 });
    expect(invoice.body.capitation).toEqual([
      expect.objectContaining({ planName: 'Gold', month: thisMonth, members: 2, rate: 500, amount: 1_000 }),
    ]);

    const counted = await admin.get(`/hmos/${hmoId}/plans/${planId}/capitation/${thisMonth}/members`);
    expect(counted.body.items.map((m: { enrolleeCode: string }) => m.enrolleeCode)).toEqual(['AVN-001', 'AVN-002']);

    // A month is billed once; cancelling the invoice frees it.
    const again = await admin.post(`/hmos/${hmoId}/invoices`, { periodStart: firstOfMonth, periodEnd: billedTo });
    expect(again.body.error.code).toBe('NOTHING_TO_INVOICE');
    await admin.patch(`/hmos/${hmoId}/invoices/${invoice.body.id}`, { status: 'cancelled' });
    const rebilled = await admin.post(`/hmos/${hmoId}/invoices`, { periodStart: firstOfMonth, periodEnd: billedTo });
    expect(rebilled.status).toBe(201);
    expect(rebilled.body.capitationAmount).toBe(1_000);

    const report = await admin.get(`/hmos/${hmoId}/capitation?months=2`);
    expect(report.body.items[0]).toMatchObject({
      month: thisMonth,
      members: 2,
      capitation: 1_000,
      billed: { reference: rebilled.body.reference },
      encounters: 1,
      doctorCost: 2_000,
      margin: -1_000,
      costRatio: 200,
    });
  });

  it('a capitation plan needs a rate, and capitated benefits need a capitation plan and a doctor fee', async () => {
    const hmo = await admin.post('/hmos', { name: 'Avon', code: 'avon' });
    const noRate = await admin.post(`/hmos/${hmo.body.id}/plans`, { name: 'Gold', paymentModel: 'capitation' });
    expect(noRate.status).toBe(400);

    const ffs = await admin.post(`/hmos/${hmo.body.id}/plans`, { name: 'Basic' });
    const ffsPlan = ffs.body.plans[0].id;
    const onFfs = await admin.post(`/hmos/${hmo.body.id}/plans/${ffsPlan}/rules`, {
      service: 'consultation',
      coverage: 'full',
      billing: 'capitation',
      doctorEarning: 2_000,
    });
    expect(onFfs.status).toBe(400);

    const cap = await admin.post(`/hmos/${hmo.body.id}/plans`, { name: 'Gold', paymentModel: 'capitation', capitationRate: 500 });
    const capPlan = cap.body.plans.find((p: { name: string }) => p.name === 'Gold').id;
    const noFee = await admin.post(`/hmos/${hmo.body.id}/plans/${capPlan}/rules`, {
      service: 'consultation',
      coverage: 'full',
      billing: 'capitation',
    });
    expect(noFee.status).toBe(400);
  });

  it('medicines stay per use, and a plan with capitated benefits cannot drop capitation', async () => {
    const { hmoId, planId } = await capitationAgreement();
    const medicines = await admin.post(`/hmos/${hmoId}/plans/${planId}/rules`, {
      service: 'medicines',
      coverage: 'full',
      billing: 'capitation',
    });
    expect(medicines.status).toBe(400);
    const noFee = await admin.post(`/hmos/${hmoId}/plans/${planId}/rules`, {
      service: 'lab_interpretation',
      coverage: 'full',
      billing: 'capitation',
    });
    expect(noFee.status).toBe(201); // labs have no doctor fee
    const drop = await admin.patch(`/hmos/${hmoId}/plans/${planId}`, { paymentModel: 'fee_for_service' });
    expect(drop.status).toBe(409);
    expect(drop.body.error.code).toBe('HMO_PLAN_HAS_CAPITATED_BENEFITS');
  });
});
