import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointments,
  labResults,
  orderCheckouts,
  PAYMENT_PROVIDERS,
  paymentWebhookEvents,
  payments,
  users,
  type PaymentProviderName,
} from '../../db/schema/index.js';
import { getPaymentProvider } from '../../integrations/payments/registry.js';
import {
  ProviderError,
  type ClientAction,
  type VerifyResult,
} from '../../integrations/payments/types.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId, paymentReference } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { round2, toMinorUnits } from '../../lib/money.js';
import { realtime } from '../../realtime/gateway.js';
import { reserveSlotForPayment } from '../appointments/appointments.service.js';
import { orderSurcharge } from '../pricing/fees.js';
import { WALLET_CURRENCY } from '../wallet/wallet.ledger.js';
import { runEffects, type Effect } from './effects.js';
import {
  confirmAppointment,
  confirmCheckout,
  confirmLabResult,
  confirmWalletTopUp,
  type FulfillmentResult,
} from './fulfillment.js';

type PaymentRow = typeof payments.$inferSelect;

export const initializePaymentSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('appointment'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
  }),
  z.object({
    purpose: z.literal('order_checkout'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
  }),
  z.object({
    purpose: z.literal('lab_result'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
  }),
  z.object({
    purpose: z.literal('wallet_topup'),
    amount: z.number().min(100).max(5_000_000),
    provider: z.enum(PAYMENT_PROVIDERS),
  }),
]);
export type InitializePaymentInput = z.infer<typeof initializePaymentSchema>;

export function serializePayment(p: PaymentRow) {
  return {
    id: p.id,
    reference: p.reference,
    purpose: p.purpose,
    purposeRefId: p.purposeRefId,
    provider: p.provider,
    status: p.status,
    baseAmount: p.baseAmount,
    surcharge: p.surcharge,
    amount: p.amount,
    currency: p.currency,
    failureReason: p.failureReason,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

interface Payable {
  purposeRefId: string | null;
  baseAmount: number;
  surcharge: number;
  currency: string;
  description: string;
}

/** Derives what is owed from server-side state. The client never supplies prices. */
async function resolvePayable(userId: string, input: InitializePaymentInput): Promise<Payable> {
  switch (input.purpose) {
    case 'appointment': {
      const [a] = await db
        .select()
        .from(appointments)
        .where(and(eq(appointments.id, input.referenceId), eq(appointments.userId, userId)))
        .limit(1);
      if (!a || a.status === 'deleted') throw notFound('Appointment');
      if (a.isTrial) throw unprocessable('NO_PAYMENT_REQUIRED', 'Trial appointments are free');
      if (a.isPaid) throw conflict('ALREADY_PAID', 'This appointment has already been paid for');
      if (a.status === 'cancelled') throw unprocessable('APPOINTMENT_CANCELLED', 'This appointment was cancelled');
      if (!a.currency || a.price <= 0) throw unprocessable('NOT_PAYABLE', 'This appointment has no payable amount');
      if (a.startTime <= new Date()) throw unprocessable('APPOINTMENT_STARTED', 'This appointment slot has passed; please rebook');
      await reserveSlotForPayment(a.id);
      return {
        purposeRefId: a.id,
        baseAmount: a.price,
        surcharge: 0,
        currency: a.currency,
        description: `Consultation: ${a.packageLabel}`,
      };
    }
    case 'order_checkout': {
      const [c] = await db
        .select()
        .from(orderCheckouts)
        .where(and(eq(orderCheckouts.id, input.referenceId), eq(orderCheckouts.userId, userId)))
        .limit(1);
      if (!c) throw notFound('Checkout');
      if (c.status !== 'awaiting_payment') throw conflict('ALREADY_PAID', 'This order has already been paid for');
      return {
        purposeRefId: c.id,
        baseAmount: c.totalAmount,
        surcharge: orderSurcharge(c.subtotal),
        currency: c.currency,
        description: 'Pharmacy order',
      };
    }
    case 'lab_result': {
      const [r] = await db
        .select()
        .from(labResults)
        .where(and(eq(labResults.id, input.referenceId), eq(labResults.userId, userId)))
        .limit(1);
      if (!r) throw notFound('Lab result');
      if (r.status !== 'awaiting_payment') throw conflict('ALREADY_PAID', 'This lab result has already been paid for');
      if (!r.price || !r.currency) throw unprocessable('NOT_PAYABLE', 'This lab result has no payable amount');
      return { purposeRefId: r.id, baseAmount: r.price, surcharge: 0, currency: r.currency, description: 'Lab result interpretation' };
    }
    case 'wallet_topup':
      return {
        purposeRefId: null,
        baseAmount: round2(input.amount),
        surcharge: 0,
        currency: WALLET_CURRENCY,
        description: 'Wallet top-up',
      };
  }
}

/**
 * Starts a payment with the chosen provider and returns the client action
 * (Stripe payment sheet secret, or a Paystack/Flutterwave checkout URL).
 * Idempotent per (user, Idempotency-Key).
 */
export async function initializePayment(userId: string, input: InitializePaymentInput, idempotencyKey?: string) {
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return existing;
  }

  const [user] = await db
    .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound('User');

  const payable = await resolvePayable(userId, input);
  const amount = round2(payable.baseAmount + payable.surcharge);
  const payment: typeof payments.$inferInsert = {
    id: newId(),
    reference: paymentReference(),
    userId,
    purpose: input.purpose,
    purposeRefId: payable.purposeRefId,
    provider: input.provider,
    status: 'pending',
    baseAmount: payable.baseAmount,
    surcharge: payable.surcharge,
    amount,
    currency: payable.currency,
    amountMinor: toMinorUnits(amount, payable.currency),
    idempotencyKey: idempotencyKey ?? null,
  };

  try {
    await db.insert(payments).values(payment);
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }

  const provider = getPaymentProvider(input.provider);
  try {
    const result = await provider.initialize({
      reference: payment.reference,
      amount,
      amountMinor: payment.amountMinor,
      currency: payable.currency,
      customer: { email: user.email, name: `${user.firstName} ${user.lastName}`.trim() },
      description: payable.description,
      metadata: { purpose: input.purpose, purposeRefId: payable.purposeRefId ?? '', userId },
    });
    await db
      .update(payments)
      .set({ providerReference: result.providerReference, metadata: { clientAction: result.clientAction } })
      .where(eq(payments.id, payment.id));
    const [row] = await db.select().from(payments).where(eq(payments.id, payment.id));
    return { payment: serializePayment(row!), clientAction: result.clientAction };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 500) : 'Provider error';
    await db.update(payments).set({ status: 'failed', failureReason: reason }).where(eq(payments.id, payment.id));
    if (err instanceof AppError) throw err;
    logger.error({ err, reference: payment.reference }, 'Payment initialization failed');
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not start the payment. Please try again.');
  }
}

async function findByIdempotencyKey(userId: string, key: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.userId, userId), eq(payments.idempotencyKey, key)))
    .limit(1);
  if (!row) return null;
  const clientAction = (row.metadata as { clientAction?: ClientAction } | null)?.clientAction ?? null;
  return { payment: serializePayment(row), clientAction };
}

// ─── Verification & settlement ───────────────────────────────────────────────

export async function getPayment(userId: string, reference: string) {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.reference, reference), eq(payments.userId, userId)))
    .limit(1);
  if (!row) throw notFound('Payment');
  return row;
}

/** Client-triggered status check (e.g. after the payment sheet/redirect closes). */
export async function verifyPayment(userId: string, reference: string) {
  const payment = await getPayment(userId, reference);
  if (payment.status !== 'pending') return serializePayment(payment);
  const result = await getPaymentProvider(payment.provider).verify(payment);
  return serializePayment(await settle(payment.id, result));
}

/**
 * The single place a payment changes state. Locks the payment row so that
 * concurrent webhook deliveries and client verifications settle exactly once,
 * checks the captured amount, then fulfils the purchase in the same transaction.
 */
export async function settle(paymentId: string, result: VerifyResult): Promise<PaymentRow> {
  if (result.outcome === 'pending') {
    const [row] = await db.select().from(payments).where(eq(payments.id, paymentId));
    return row!;
  }

  let effects: Effect[] = [];
  const settled = await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'pending') return payment; // Already settled: idempotent no-op.

    if (result.outcome === 'failed') {
      await tx
        .update(payments)
        .set({ status: 'failed', failureReason: result.failureReason ?? 'Payment failed', providerReference: result.providerReference ?? payment.providerReference })
        .where(eq(payments.id, paymentId));
      return { ...payment, status: 'failed' as const };
    }

    const amountOk = result.amountMinor >= payment.amountMinor;
    const currencyOk = result.currency.toUpperCase() === payment.currency.toUpperCase();
    if (!amountOk || !currencyOk) {
      logger.error(
        { reference: payment.reference, expected: [payment.amountMinor, payment.currency], got: [result.amountMinor, result.currency] },
        'Payment amount/currency mismatch — not fulfilling',
      );
      await tx
        .update(payments)
        .set({ status: 'failed', failureReason: 'Captured amount or currency does not match the order' })
        .where(eq(payments.id, paymentId));
      return { ...payment, status: 'failed' as const };
    }

    const paidAt = new Date();
    let outcome: FulfillmentResult;
    switch (payment.purpose) {
      case 'appointment':
        outcome = await confirmAppointment(tx, payment.purposeRefId!, { currency: payment.currency });
        break;
      case 'order_checkout':
        outcome = await confirmCheckout(tx, payment.purposeRefId!);
        break;
      case 'lab_result':
        outcome = await confirmLabResult(tx, payment.purposeRefId!);
        break;
      case 'wallet_topup':
        outcome = await confirmWalletTopUp(tx, payment);
        break;
    }
    effects = outcome.effects;

    const metadata = { ...(payment.metadata ?? {}), ...(outcome.duplicate && { refundReview: 'target already fulfilled by another payment' }) };
    if (outcome.duplicate) {
      logger.warn({ reference: payment.reference, purpose: payment.purpose }, 'Duplicate payment captured; flagged for refund review');
    }
    await tx
      .update(payments)
      .set({ status: 'succeeded', paidAt, providerReference: result.providerReference ?? payment.providerReference, metadata })
      .where(eq(payments.id, paymentId));
    return { ...payment, status: 'succeeded' as const, paidAt, metadata };
  });

  await runEffects([
    ...effects,
    () => realtime.toUser(settled.userId, 'payment:updated', { reference: settled.reference, status: settled.status, purpose: settled.purpose }),
  ]);
  return settled;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Handles a provider webhook. The signature is verified, the event is recorded
 * (redeliveries become no-ops), and the payment status is re-read from the
 * provider API before settling — webhook payloads are never trusted for amounts.
 */
export async function handleWebhook(
  providerName: PaymentProviderName,
  rawBody: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
) {
  if (!rawBody?.length) throw badRequest('Empty webhook body');
  const provider = getPaymentProvider(providerName);
  const event = provider.parseWebhook(rawBody, headers);

  const eventRowId = newId();
  try {
    await db.insert(paymentWebhookEvents).values({
      id: eventRowId,
      provider: providerName,
      eventId: event.eventId,
      eventType: event.eventType,
      paymentReference: event.reference,
      payload: event.payload as object,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const [existing] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, providerName), eq(paymentWebhookEvents.eventId, event.eventId)));
    if (existing?.processedAt) return { status: 'duplicate' as const };
    return processWebhookEvent(providerName, existing!.id, event.reference);
  }
  return processWebhookEvent(providerName, eventRowId, event.reference);
}

async function processWebhookEvent(providerName: PaymentProviderName, eventRowId: string, reference: string | null) {
  try {
    if (reference) {
      const [payment] = await db
        .select()
        .from(payments)
        .where(and(eq(payments.reference, reference), eq(payments.provider, providerName)))
        .limit(1);
      if (payment && payment.status === 'pending') {
        const result = await getPaymentProvider(providerName).verify(payment);
        await settle(payment.id, result);
      }
    }
    await db.update(paymentWebhookEvents).set({ processedAt: new Date(), error: null }).where(eq(paymentWebhookEvents.id, eventRowId));
    return { status: 'processed' as const };
  } catch (err) {
    const message = err instanceof ProviderError || err instanceof Error ? err.message : String(err);
    await db.update(paymentWebhookEvents).set({ error: message.slice(0, 2000) }).where(eq(paymentWebhookEvents.id, eventRowId));
    throw err; // Non-2xx makes the provider retry.
  }
}
