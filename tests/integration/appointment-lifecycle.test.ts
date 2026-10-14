import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, appointmentMessages, appointments, payments, users } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { closeFinishedAppointments, remindDoctorsToComplete } from '../../src/modules/appointments/appointment-lifecycle.js';
import { balances } from '../../src/modules/doctor-payouts/doctor-payouts.ledger.js';
import { api, auth, createDoctor, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

let adminToken: string;
const admin = {
  get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(adminToken)),
  post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
};

/** A paid consultation that ended an hour ago (past the 30-minute grace). */
async function endedVisit(doctorId: string | null, patientId: string, values: Partial<typeof appointments.$inferInsert> = {}) {
  const id = newId();
  await db.insert(appointments).values({
    id, userId: patientId, doctorId, symptoms: [], status: 'active', packageLabel: 'GP',
    startTime: inHours(-2), endTime: inHours(-1), price: 7_500, currency: 'NGN', isPaid: true, doctorEarning: 4_500,
    ...values,
  });
  return id;
}
const statusOf = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;
const owed = async (doctorId: string) => (await balances(doctorId)).find((b) => b.currency === 'NGN')?.balance ?? 0;

beforeEach(async () => {
  await resetDatabase();
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
});

describe('closing finished consultations', () => {
  it('completes consultations the doctor took part in (chat or answered call) and pays the doctor', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    const chatted = await endedVisit(doctor.id, patient.id);
    await db.insert(appointmentMessages).values({ id: newId(), appointmentId: chatted, senderId: doctor.id, receiverId: patient.id, message: 'Hello, how are you feeling?' });
    const called = await endedVisit(doctor.id, patient.id, { doctorJoinedAt: inHours(-1.5) });
    const running = await endedVisit(doctor.id, patient.id, { endTime: inHours(-0.25) }); // still within the grace

    const result = await closeFinishedAppointments();
    expect(result).toMatchObject({ completed: 2, flagged: 0 });
    expect(await statusOf(chatted)).toMatchObject({ status: 'completed', completedBy: 'auto' });
    expect(await statusOf(called)).toMatchObject({ status: 'completed', completedBy: 'auto' });
    expect((await statusOf(running)).status).toBe('active');
    expect(await owed(doctor.id)).toBe(9_000);
  });

  it('reminds the doctor once at the end time', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    const id = await endedVisit(doctor.id, patient.id, { endTime: inHours(-0.1) });
    expect(await remindDoctorsToComplete()).toBe(1);
    expect(await remindDoctorsToComplete()).toBe(0);
    expect((await statusOf(id)).completionRemindedAt).not.toBeNull();
  });

  it('sends a consultation with no doctor activity to review; completing it pays the doctor', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    const silent = await endedVisit(doctor.id, patient.id);
    expect(await closeFinishedAppointments()).toMatchObject({ completed: 0, flagged: 1 });
    expect(await statusOf(silent)).toMatchObject({ status: 'active', reviewReason: 'no_activity' });
    expect(await owed(doctor.id)).toBe(0);

    const queue = await admin.get('/appointments/review');
    expect(queue.body.items).toEqual([expect.objectContaining({ id: silent, reviewReason: 'no_activity', doctorMessages: 0 })]);
    const done = await admin.post(`/appointments/${silent}/review`, { action: 'complete' });
    expect(done.body).toMatchObject({ status: 'completed' });
    expect(await statusOf(silent)).toMatchObject({ completedBy: 'admin', needsReviewAt: null });
    expect(await owed(doctor.id)).toBe(4_500);
    // Not flagged again.
    expect(await closeFinishedAppointments()).toMatchObject({ flagged: 0 });
  });

  it('a paid booking no doctor accepted goes to review; cancelling refunds the naira payment to the wallet once', async () => {
    const patient = await createUser();
    const id = await endedVisit(null, patient.id, { status: 'pending' });
    await db.insert(payments).values({
      id: newId(), reference: `ref-${id}`, userId: patient.id, purpose: 'appointment', purposeRefId: id, provider: 'paystack',
      status: 'succeeded', baseAmount: 7_500, surcharge: 150, amount: 7_650, currency: 'NGN', amountMinor: 765_000, paidAt: new Date(),
    });
    expect(await closeFinishedAppointments()).toMatchObject({ flagged: 1 });
    expect((await statusOf(id)).reviewReason).toBe('not_accepted');

    const cannotComplete = await admin.post(`/appointments/${id}/review`, { action: 'complete' });
    expect(cannotComplete.status).toBe(400);
    const cancelled = await admin.post(`/appointments/${id}/review`, { action: 'cancel', refund: true });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', refunded: 7_650 });
    const [wallet] = await db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, patient.id));
    expect(wallet!.balance).toBe(7_650);
    const again = await admin.post(`/appointments/${id}/review`, { action: 'cancel', refund: true });
    expect(again.status).toBe(400);
  });

  it('a payment in another currency must be refunded through the provider', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    const id = await endedVisit(doctor.id, patient.id, { currency: 'USD', price: 10 });
    await db.insert(payments).values({
      id: newId(), reference: `ref-${id}`, userId: patient.id, purpose: 'appointment', purposeRefId: id, provider: 'stripe',
      status: 'succeeded', baseAmount: 10, surcharge: 0, amount: 10, currency: 'USD', amountMinor: 1_000, paidAt: new Date(),
    });
    await closeFinishedAppointments();
    const refund = await admin.post(`/appointments/${id}/review`, { action: 'cancel', refund: true });
    expect(refund.body.error.code).toBe('REFUND_NOT_IN_NAIRA');
    const cancel = await admin.post(`/appointments/${id}/review`, { action: 'cancel', refund: false });
    expect(cancel.body).toMatchObject({ status: 'cancelled', refunded: 0 });
  });
});
