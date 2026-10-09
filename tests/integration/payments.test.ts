import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appointments, notifications, payments, referrals, users } from '../../src/db/schema/index.js';
import { registerPaymentProvider } from '../../src/integrations/payments/registry.js';
import { primeRates } from '../../src/integrations/exchange-rates.js';
import type { PaymentProvider, VerifyResult } from '../../src/integrations/payments/types.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { reconcilePendingPayments } from '../../src/modules/payments/payments.service.js';
import { api, auth, createDoctor, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

/** Fake Paystack: real webhook signing, scripted verification results. */
class FakePaystack implements PaymentProvider {
  readonly name = 'paystack' as const;
  initializeCalls = 0;
  outcome: (ref: string) => VerifyResult = () => ({ outcome: 'pending', amountMinor: 0, currency: 'NGN', providerReference: null });

  async initialize(input: { reference: string }) {
    this.initializeCalls++;
    return {
      providerReference: null,
      clientAction: { type: 'redirect' as const, authorizationUrl: `https://checkout.test/${input.reference}` },
    };
  }

  async verify(p: { reference: string }) {
    return this.outcome(p.reference);
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    const expected = createHmac('sha512', 'fake').update(raw).digest('hex');
    if (headers['x-paystack-signature'] !== expected) throw new Error('bad signature');
    const e = JSON.parse(raw.toString()) as { event: string; data: { id: number; reference: string } };
    return { eventId: `${e.event}:${e.data.id}`, eventType: e.event, reference: e.data.reference, payload: e };
  }
}

afterAll(() => closeDatabase());

const sign = (body: string) => createHmac('sha512', 'fake').update(body).digest('hex');

describe('payments', () => {
  let provider: FakePaystack;
  let patient: Awaited<ReturnType<typeof createUser>>;
  let doctor: Awaited<ReturnType<typeof createDoctor>>;
  let appointmentId: string;

  beforeEach(async () => {
    await resetDatabase();
    provider = new FakePaystack();
    registerPaymentProvider(provider);

    const referrer = await createUser({ tag: 'refboss' });
    patient = await createUser({ country: 'NG', currency: 'NGN' });
    await db.insert(referrals).values({ id: newId(), userId: patient.id, referrerTag: 'refboss', referrerId: referrer.id });
    doctor = await createDoctor();
    const packageId = await createPackage({ amountUsd: 10 });
    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'pay-flow-booking')
      .send({ packageId, doctorId: doctor.id, startTime: inHours(5) });
    appointmentId = booked.body.id;
  });

  const initialize = (key: string) =>
    api()
      .post('/api/v1/payments')
      .set(auth(patient.token))
      .set('Idempotency-Key', key)
      .send({ purpose: 'appointment', referenceId: appointmentId, provider: 'paystack' });

  it('initializes once per idempotency key with a server-side amount', async () => {
    const a = await initialize('pay-init-key-01');
    const b = await initialize('pay-init-key-01');
    expect(a.status).toBe(201);
    expect(b.body.payment.reference).toBe(a.body.payment.reference);
    expect(a.body.payment).toMatchObject({ amount: 7500, currency: 'NGN', status: 'pending' });
    expect(a.body.clientAction.type).toBe('redirect');
    expect(provider.initializeCalls).toBe(1);
  });

  it('settles on verify, fulfils the appointment and pays referral commission once', async () => {
    const { body } = await initialize('pay-init-key-02');
    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '999' });

    const [v1, v2] = await Promise.all([
      api().post(`/api/v1/payments/${body.payment.reference}/verify`).set(auth(patient.token)),
      api().post(`/api/v1/payments/${body.payment.reference}/verify`).set(auth(patient.token)),
    ]);
    expect(v1.body.status).toBe('succeeded');
    expect(v2.body.status).toBe('succeeded');

    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt).toMatchObject({ isPaid: true, doctorEarning: 4500 });
    const [ref] = await db.select().from(referrals).where(eq(referrals.userId, patient.id));
    expect(ref!.totalCommissionEarned).toBe(750);
    const [referrer] = await db.select().from(users).where(eq(users.tag, 'refboss'));
    expect(referrer!.referralBalance).toBe(750);
  });

  it('settles doctor and referral earnings using the policy stored when payment started', async () => {
    const adminToken = signAdminAccessToken({ sub: newId(), role: 'admin' });
    const authAdmin = { Authorization: `Bearer ${adminToken}` };
    await api().put('/api/v1/admin/commercial-fees').set(authAdmin).send({
      gatewayFeePercent: 0,
      orderSurchargePercent: 2,
      consultationPlatformPercent: 25,
      pharmacyPlatformPercent: 5,
      referralCommissionPercent: 20,
    }).expect(200);

    const { body } = await initialize('pay-fee-snapshot-key');
    await api().put('/api/v1/admin/commercial-fees').set(authAdmin).send({
      gatewayFeePercent: 0,
      orderSurchargePercent: 2,
      consultationPlatformPercent: 50,
      pharmacyPlatformPercent: 5,
      referralCommissionPercent: 5,
    }).expect(200);
    provider.outcome = () => ({
      outcome: 'succeeded',
      amountMinor: 750_000,
      currency: 'NGN',
      providerReference: '998',
    });
    await api()
      .post(`/api/v1/payments/${body.payment.reference}/verify`)
      .set(auth(patient.token))
      .expect(200);

    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt!.doctorEarning).toBe(5625);
    const [ref] = await db.select().from(referrals).where(eq(referrals.userId, patient.id));
    expect(ref!.totalCommissionEarned).toBe(1500);
    const doctorAppointment = await api()
      .get(`/api/v1/appointments/${appointmentId}`)
      .set(auth(doctor.token));
    expect(doctorAppointment.body.doctorEarning).toBe(5625);
    const patientAppointment = await api()
      .get(`/api/v1/appointments/${appointmentId}`)
      .set(auth(patient.token));
    expect(patientAppointment.body).not.toHaveProperty('doctorEarning');
  });

  it('locks the doctor earning currency and FX rate when payment starts', async () => {
    primeRates({ NGN: 1500 });
    await db.update(users).set({ earningCurrency: 'USD' }).where(eq(users.id, doctor.id));
    const { body } = await initialize('pay-earning-currency-snapshot');
    await db.update(users).set({ earningCurrency: 'EUR' }).where(eq(users.id, doctor.id));
    provider.outcome = () => ({
      outcome: 'succeeded',
      amountMinor: 750_000,
      currency: 'NGN',
      providerReference: 'earning-fx',
    });

    await api()
      .post(`/api/v1/payments/${body.payment.reference}/verify`)
      .set(auth(patient.token))
      .expect(200);

    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt).toMatchObject({
      doctorEarning: 4500,
      doctorEarningConverted: 3,
      doctorEarningCurrency: 'USD',
    });
    expect(appt!.doctorEarningExchangeRate).toBeCloseTo(1 / 1500, 7);
    expect(appt!.doctorEarningConvertedAt).toBeInstanceOf(Date);
    const doctorView = await api()
      .get(`/api/v1/appointments/${appointmentId}`)
      .set(auth(doctor.token));
    expect(doctorView.body).toMatchObject({ doctorEarning: 3, doctorEarningCurrency: 'USD' });
  });

  it('pays the referral commission once even if two bookings are paid concurrently', async () => {
    const doctor2 = await createDoctor();
    const packageId = await createPackage({ amountUsd: 10 });
    const second = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'pay-flow-booking-2')
      .send({ packageId, doctorId: doctor2.id, startTime: inHours(9) });
    const pay = (referenceId: string, key: string) =>
      api()
        .post('/api/v1/payments')
        .set(auth(patient.token))
        .set('Idempotency-Key', key)
        .send({ purpose: 'appointment', referenceId, provider: 'paystack' });
    const [p1, p2] = await Promise.all([pay(appointmentId, 'pay-both-key-01'), pay(second.body.id, 'pay-both-key-02')]);
    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '5' });

    await Promise.all(
      [p1, p2].map((p) => api().post(`/api/v1/payments/${p.body.payment.reference}/verify`).set(auth(patient.token))),
    );

    const [ref] = await db.select().from(referrals).where(eq(referrals.userId, patient.id));
    expect(ref!.totalCommissionEarned).toBe(750);
  });

    it('refuses to fulfil when the captured amount is short', async () => {
    const { body } = await initialize('pay-init-key-03');
    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 100, currency: 'NGN', providerReference: '1' });
    const res = await api().post(`/api/v1/payments/${body.payment.reference}/verify`).set(auth(patient.token));
    expect(res.body.status).toBe('failed');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt!.isPaid).toBe(false);
  });

  it('processes a signed webhook once and ignores redeliveries', async () => {
    const { body } = await initialize('pay-init-key-04');
    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '77' });
    const event = JSON.stringify({ event: 'charge.success', data: { id: 77, reference: body.payment.reference } });

    const send = () =>
      api()
        .post('/api/v1/webhooks/paystack')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', sign(event))
        .send(event);
    const first = await send();
    const second = await send();

    expect(first.body.status).toBe('processed');
    expect(second.body.status).toBe('duplicate');
    const [payment] = await db.select().from(payments).where(eq(payments.reference, body.payment.reference));
    expect(payment!.status).toBe('succeeded');
    const userNotes = await db.select().from(notifications).where(eq(notifications.userId, patient.id));
    expect(userNotes).toHaveLength(1);
  });

  it('rejects webhooks with a bad signature', async () => {
    const res = await api()
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'forged')
      .send(JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'x' } }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  describe('reconciliation (lost webhook, app crashed mid-checkout)', () => {
    const backdate = (reference: string, minutes: number) =>
      db
        .update(payments)
        .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
        .where(eq(payments.reference, reference));
    const paymentRow = async (reference: string) =>
      (await db.select().from(payments).where(eq(payments.reference, reference)))[0]!;

    it('settles a paid checkout that nobody verified and fulfils it once', async () => {
      const { body } = await initialize('pay-recon-key-01');
      await backdate(body.payment.reference, 10);
      provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '777' });

      // Overlapping sweeps (or two API instances): the row lock makes the
      // second a no-op, so the purchase is fulfilled exactly once.
      const [a, b] = await Promise.all([reconcilePendingPayments(), reconcilePendingPayments()]);
      expect(a.succeeded + b.succeeded).toBeGreaterThanOrEqual(1);
      expect((await paymentRow(body.payment.reference)).status).toBe('succeeded');
      const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
      expect(appt).toMatchObject({ isPaid: true });
      const [ref] = await db.select().from(referrals).where(eq(referrals.userId, patient.id));
      expect(ref!.totalCommissionEarned).toBe(750);
    });

    it('leaves fresh checkouts to the app and webhook', async () => {
      const { body } = await initialize('pay-recon-key-02');
      provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '778' });
      const summary = await reconcilePendingPayments();
      expect(summary.checked).toBe(0);
      expect((await paymentRow(body.payment.reference)).status).toBe('pending');
    });

    it('keeps an unpaid checkout pending and stops after the window', async () => {
      const { body } = await initialize('pay-recon-key-03');
      await backdate(body.payment.reference, 10);
      expect((await reconcilePendingPayments()).checked).toBe(1);
      expect((await paymentRow(body.payment.reference)).status).toBe('pending');

      await backdate(body.payment.reference, 4 * 24 * 60);
      expect((await reconcilePendingPayments()).checked).toBe(0);
    });

    it('records a declined payment as failed', async () => {
      const { body } = await initialize('pay-recon-key-04');
      await backdate(body.payment.reference, 10);
      provider.outcome = () => ({ outcome: 'failed', amountMinor: 0, currency: 'NGN', providerReference: '779', failureReason: 'Declined' });
      expect((await reconcilePendingPayments()).failed).toBe(1);
      expect((await paymentRow(body.payment.reference)).status).toBe('failed');
      const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
      expect(appt!.isPaid).toBe(false);
    });
  });

  it('will not take payment for an already paid appointment', async () => {
    await db.update(appointments).set({ isPaid: true }).where(eq(appointments.id, appointmentId));
    const res = await initialize('pay-init-key-05');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_PAID');
  });
});
