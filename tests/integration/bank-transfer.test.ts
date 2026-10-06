import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appointments, payments } from '../../src/db/schema/index.js';
import { registerPaymentProvider } from '../../src/integrations/payments/registry.js';
import { ProviderError, type InitializeInput, type PaymentProvider, type VerifyResult } from '../../src/integrations/payments/types.js';
import { api, auth, createDoctor, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

/** Fake Paystack that issues a temporary transfer account, like Pay with Transfer. */
class FakePaystack implements PaymentProvider {
  readonly name = 'paystack' as const;
  inputs: InitializeInput[] = [];
  feeMinor = 0;
  outcome: () => VerifyResult = () => ({ outcome: 'pending', amountMinor: 0, currency: 'NGN', providerReference: null });

  async initialize(input: InitializeInput) {
    this.inputs.push(input);
    if (input.method === 'bank_transfer') {
      return {
        providerReference: input.reference,
        collectAmountMinor: input.amountMinor + this.feeMinor,
        clientAction: {
          type: 'bank_transfer' as const,
          accountName: 'INSTANT DOCTOR CHECKOUT',
          accountNumber: `12600${this.inputs.length}`,
          bankName: 'Wema Bank',
          expiresAt: input.transferExpiresAt!,
          displayText: 'Please make a transfer to the account specified',
        },
      };
    }
    return {
      providerReference: null,
      clientAction: { type: 'redirect' as const, authorizationUrl: `https://checkout.test/${input.reference}` },
    };
  }

  async verify() {
    return this.outcome();
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>) {
    if (headers['x-paystack-signature'] !== createHmac('sha512', 'fake').update(raw).digest('hex')) throw new Error('bad signature');
    const e = JSON.parse(raw.toString()) as { event: string; data: { id: number; reference: string } };
    return { eventId: `${e.event}:${e.data.id}`, eventType: e.event, reference: e.data.reference, payload: e };
  }
}

afterAll(() => closeDatabase());

describe('Paystack bank transfer', () => {
  let provider: FakePaystack;
  let patient: Awaited<ReturnType<typeof createUser>>;
  let appointmentId: string;

  const start = (key: string, overrides: Record<string, unknown> = {}) =>
    api()
      .post('/api/v1/payments')
      .set(auth(patient.token))
      .set('Idempotency-Key', key)
      .send({ purpose: 'appointment', referenceId: appointmentId, provider: 'paystack', method: 'bank_transfer', ...overrides });
  const transferSent = (reference: string) =>
    api().post(`/api/v1/payments/${reference}/transfer-sent`).set(auth(patient.token));
  const paid = (): VerifyResult => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '42' });

  beforeEach(async () => {
    await resetDatabase();
    provider = new FakePaystack();
    registerPaymentProvider(provider);
    patient = await createUser({ country: 'NG', currency: 'NGN' });
    const doctor = await createDoctor();
    const packageId = await createPackage({ amountUsd: 10 });
    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'bt-booking-0001')
      .send({ packageId, doctorId: doctor.id, startTime: inHours(5) });
    appointmentId = booked.body.id;
  });

  it('returns the account to transfer to, valid for 30 minutes', async () => {
    const res = await start('bt-init-0001');

    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ method: 'bank_transfer', status: 'pending', amount: 7500, currency: 'NGN' });
    expect(res.body.clientAction).toMatchObject({
      type: 'bank_transfer',
      accountName: 'INSTANT DOCTOR CHECKOUT',
      bankName: 'Wema Bank',
      accountNumber: expect.any(String),
    });
    const minutesLeft = (Date.parse(res.body.clientAction.expiresAt) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(29);
    expect(minutesLeft).toBeLessThanOrEqual(30);
    expect(res.body.payment.bankTransfer.accountNumber).toBe(res.body.clientAction.accountNumber);
  });

  it('shows the fee-inclusive total when Paystack passes its fee to the customer', async () => {
    provider.feeMinor = 11_418;
    const res = await start('bt-init-fee-01');
    expect(res.body.payment).toMatchObject({ amount: 7614.18, surcharge: 114.18, baseAmount: 7500 });

    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 750_000, currency: 'NGN', providerReference: '1' });
    const short = await transferSent(res.body.payment.reference);
    expect(short.body.status).toBe('failed');
  });

  it('accepts the fee-inclusive transfer', async () => {
    provider.feeMinor = 11_418;
    const res = await start('bt-init-fee-02');
    provider.outcome = () => ({ outcome: 'succeeded', amountMinor: 761_418, currency: 'NGN', providerReference: '1' });
    expect((await transferSent(res.body.payment.reference)).body.status).toBe('succeeded');
  });

  it('holds the doctor slot for the whole transfer window', async () => {
    await start('bt-init-0002');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect((appt!.holdExpiresAt!.getTime() - Date.now()) / 60_000).toBeGreaterThan(44);
  });

  it('re-shows the same open account instead of issuing a second one', async () => {
    const first = await start('bt-init-0003');
    const second = await start('bt-init-0004'); // new attempt, e.g. after the app was closed
    expect(second.body.payment.reference).toBe(first.body.payment.reference);
    expect(second.body.clientAction.accountNumber).toBe(first.body.clientAction.accountNumber);
    expect(provider.inputs).toHaveLength(1);
  });

  it('"I\'ve sent the money" records the claim and stays pending until the money lands', async () => {
    const { body } = await start('bt-init-0005');
    const res = await transferSent(body.payment.reference);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.bankTransfer.customerConfirmedAt).not.toBeNull();
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt!.isPaid).toBe(false);
  });

  it('"I\'ve sent the money" still moves to pending when Paystack cannot be reached', async () => {
    const { body } = await start('bt-init-0012');
    provider.outcome = () => {
      throw new ProviderError('paystack', 'Service unavailable', undefined, 503);
    };
    const res = await transferSent(body.payment.reference);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.bankTransfer.customerConfirmedAt).not.toBeNull();

    const verify = await api().post(`/api/v1/payments/${body.payment.reference}/verify`).set(auth(patient.token));
    expect(verify.status).toBe(502);
    expect(verify.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
  });

  it('confirms the appointment once Paystack reports the transfer', async () => {
    const { body } = await start('bt-init-0006');
    provider.outcome = paid;
    const res = await transferSent(body.payment.reference);
    expect(res.body.status).toBe('succeeded');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt!.isPaid).toBe(true);
  });

  it('settles from the charge.success webhook without the customer doing anything', async () => {
    const { body } = await start('bt-init-0007');
    provider.outcome = paid;
    const event = JSON.stringify({ event: 'charge.success', data: { id: 99, reference: body.payment.reference } });
    const hook = await api()
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', createHmac('sha512', 'fake').update(event).digest('hex'))
      .send(event);
    expect(hook.body.status).toBe('processed');
    const [row] = await db.select().from(payments).where(eq(payments.reference, body.payment.reference));
    expect(row!.status).toBe('succeeded');
  });

  it('expires once the window and grace period pass with no money', async () => {
    const { body } = await start('bt-init-0008');
    await db.update(payments).set({ expiresAt: new Date(Date.now() - 16 * 60_000) }).where(eq(payments.reference, body.payment.reference));
    const res = await transferSent(body.payment.reference);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.failureReason).toMatch(/expired/);
  });

  it('still honours a transfer that lands after the payment expired', async () => {
    const { body } = await start('bt-init-0009');
    await db
      .update(payments)
      .set({ status: 'cancelled', failureReason: 'The transfer window expired before the payment arrived' })
      .where(eq(payments.reference, body.payment.reference));
    provider.outcome = paid;
    const event = JSON.stringify({ event: 'charge.success', data: { id: 7, reference: body.payment.reference } });
    await api()
      .post('/api/v1/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', createHmac('sha512', 'fake').update(event).digest('hex'))
      .send(event);
    const [row] = await db.select().from(payments).where(eq(payments.reference, body.payment.reference));
    expect(row!.status).toBe('succeeded');
    const [appt] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(appt!.isPaid).toBe(true);
  });

  it('an expired transfer is re-checked on verify, so late money is picked up there too', async () => {
    const { body } = await start('bt-init-0011');
    await db
      .update(payments)
      .set({ status: 'cancelled', failureReason: 'The transfer window expired before the payment arrived' })
      .where(eq(payments.reference, body.payment.reference));
    provider.outcome = paid;
    const res = await api().post(`/api/v1/payments/${body.payment.reference}/verify`).set(auth(patient.token));
    expect(res.body.status).toBe('succeeded');
  });

  it('rejects bank transfer with providers other than Paystack', async () => {
    const res = await start('bt-init-0010', { provider: 'flutterwave' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('METHOD_NOT_SUPPORTED');
  });

  it('rejects bank transfer for non-NGN payments', async () => {
    const usd = await createUser({ country: 'US', currency: 'USD' });
    const doctor = await createDoctor();
    const packageId = await createPackage({ amountUsd: 10 });
    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(usd.token))
      .set('Idempotency-Key', 'bt-usd-booking')
      .send({ packageId, doctorId: doctor.id, startTime: inHours(7) });
    const res = await api()
      .post('/api/v1/payments')
      .set(auth(usd.token))
      .set('Idempotency-Key', 'bt-usd-init-01')
      .send({ purpose: 'appointment', referenceId: booked.body.id, provider: 'paystack', method: 'bank_transfer' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('METHOD_NOT_SUPPORTED');
  });

  it('card payments go to checkout and cannot use transfer-sent', async () => {
    const res = await start('bt-card-0001', { method: 'card' });
    expect(res.body.clientAction.type).toBe('redirect');
    expect(provider.inputs[0]!.method).toBe('card');
    expect((await transferSent(res.body.payment.reference)).body.error.code).toBe('NOT_BANK_TRANSFER');
  });
});
