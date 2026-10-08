import { and, asc, desc, eq, gt, isNotNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointments,
  labResults,
  orderCheckouts,
  PAYMENT_METHODS,
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
import { fromMinorUnits, round2, toMinorUnits } from '../../lib/money.js';
import { realtime } from '../../realtime/gateway.js';
import { reserveSlotForPayment } from '../appointments/appointments.service.js';
import { orderSurcharge } from '../pricing/fees.js';
import { WALLET_CURRENCY } from '../wallet/wallet.ledger.js';
import { familySubscriptionPrice, requireFamilySubscription } from '../subscriptions/subscriptions.service.js';
import { runEffects, type Effect } from './effects.js';
import {
  confirmAppointment,
  confirmCheckout,
  confirmLabResult,
  confirmFamilySubscription,
  confirmWalletTopUp,
  type FulfillmentResult,
} from './fulfillment.js';

type PaymentRow = typeof payments.$inferSelect;

export const initializePaymentSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('appointment'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS).default('card'),
  }),
  z.object({
    purpose: z.literal('order_checkout'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS).default('card'),
  }),
  z.object({
    purpose: z.literal('lab_result'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS).default('card'),
  }),
  z.object({
    purpose: z.literal('wallet_topup'),
    amount: z.number().min(100).max(5_000_000),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS).default('card'),
  }),
  z.object({
    purpose: z.literal('family_subscription'),
    referenceId: z.string().min(1).max(36),
    provider: z.enum(PAYMENT_PROVIDERS),
    method: z.enum(PAYMENT_METHODS).default('card'),
  }),
]);
export type InitializePaymentInput = z.infer<typeof initializePaymentSchema>;

/** Paystack "Pay with Transfer": how long the temporary account accepts money. */
export const BANK_TRANSFER_WINDOW_MINUTES = 30;
/** Transfers can land a little after the window closes; wait this long before expiring the payment. */
export const BANK_TRANSFER_GRACE_MINUTES = 15;
/** Paystack's Pay with Transfer is NGN-only. */
const BANK_TRANSFER_CURRENCIES = new Set(['NGN']);

/** Still worth asking the provider about: pending, or an expired transfer whose money may yet land. */
const awaitingMoney = (p: Pick<PaymentRow, 'status' | 'method'>) =>
  p.status === 'pending' || (p.status === 'cancelled' && p.method === 'bank_transfer');

const bankTransferAction = (p: Pick<PaymentRow, 'metadata'>) => {
  const action = (p.metadata as { clientAction?: ClientAction } | null)?.clientAction;
  return action?.type === 'bank_transfer' ? action : null;
};

export function serializePayment(p: PaymentRow) {
  const transfer = bankTransferAction(p);
  return {
    id: p.id,
    reference: p.reference,
    purpose: p.purpose,
    purposeRefId: p.purposeRefId,
    provider: p.provider,
    method: p.method,
    status: p.status,
    baseAmount: p.baseAmount,
    surcharge: p.surcharge,
    amount: p.amount,
    currency: p.currency,
    failureReason: p.failureReason,
    paidAt: p.paidAt,
    /** Present for bank transfers, so the app can re-open the account details screen. */
    bankTransfer: transfer
      ? {
          accountName: transfer.accountName,
          accountNumber: transfer.accountNumber,
          bankName: transfer.bankName,
          expiresAt: transfer.expiresAt,
          customerConfirmedAt: p.customerConfirmedAt,
        }
      : null,
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
      // A bank transfer can take the whole transfer window: hold the slot until it closes.
      await reserveSlotForPayment(
        a.id,
        input.method === 'bank_transfer' ? BANK_TRANSFER_WINDOW_MINUTES + BANK_TRANSFER_GRACE_MINUTES : undefined,
      );
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
    case 'family_subscription': {
      await requireFamilySubscription(userId, input.referenceId);
      const price = await familySubscriptionPrice(userId);
      return {
        purposeRefId: input.referenceId,
        baseAmount: price.amount,
        surcharge: 0,
        currency: price.currency,
        description: 'Family Care monthly membership',
      };
    }
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
    if (existing) {
      // A previous request can fail before the provider has supplied its
      // checkout action. Never present that incomplete record as a successful
      // initialization response.
      if (existing.payment.status === 'pending' && !existing.clientAction) {
        throw new AppError(
          503,
          'PAYMENT_INITIALIZATION_INTERRUPTED',
          'Payment initialization was interrupted. Please try again.',
        );
      }
      return existing;
    }
  }

  const [user] = await db
    .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound('User');

  if (input.method === 'bank_transfer' && input.provider !== 'paystack') {
    throw unprocessable('METHOD_NOT_SUPPORTED', 'Bank transfer is only available with Paystack');
  }
  if (input.method === 'bank_transfer') {
    // Re-show the account already issued for this purchase instead of opening a second one
    // (a customer paying into both would be charged twice).
    const live = await findLiveBankTransfer(userId, input);
    if (live) return live;
  }

  const payable = await resolvePayable(userId, input);
  if (input.method === 'bank_transfer' && !BANK_TRANSFER_CURRENCIES.has(payable.currency)) {
    throw unprocessable('METHOD_NOT_SUPPORTED', `Bank transfer is only available for payments in NGN (this one is ${payable.currency})`);
  }
  const transferExpiresAt =
    input.method === 'bank_transfer' ? new Date(Date.now() + BANK_TRANSFER_WINDOW_MINUTES * 60_000) : null;
  // Validate provider configuration before creating a local payment row. This
  // prevents a missing test credential from leaving a pending payment with no
  // clientAction for a retried idempotent request.
  const provider = getPaymentProvider(input.provider);
  const amount = round2(payable.baseAmount + payable.surcharge);
  const payment: typeof payments.$inferInsert = {
    id: newId(),
    reference: paymentReference(),
    userId,
    purpose: input.purpose,
    purposeRefId: payable.purposeRefId,
    provider: input.provider,
    method: input.method,
    status: 'pending',
    expiresAt: transferExpiresAt,
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

  try {
    const result = await provider.initialize({
      reference: payment.reference,
      amount,
      amountMinor: payment.amountMinor,
      currency: payable.currency,
      customer: { email: user.email, name: `${user.firstName} ${user.lastName}`.trim() },
      description: payable.description,
      metadata: { purpose: input.purpose, purposeRefId: payable.purposeRefId ?? '', userId },
      method: input.method,
      transferExpiresAt: transferExpiresAt?.toISOString(),
    });
    const providerFeeMinor = Math.max(0, (result.collectAmountMinor ?? payment.amountMinor) - payment.amountMinor);
    const providerFee = fromMinorUnits(providerFeeMinor, payable.currency);
    await db
      .update(payments)
      .set({
        providerReference: result.providerReference,
        metadata: { clientAction: result.clientAction },
        ...(providerFeeMinor > 0 && {
          surcharge: round2(payable.surcharge + providerFee),
          amount: round2(amount + providerFee),
          amountMinor: payment.amountMinor + providerFeeMinor,
        }),
      })
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

/** A still-open bank transfer for the same purchase (not for wallet top-ups, whose amount varies). */
async function findLiveBankTransfer(userId: string, input: InitializePaymentInput) {
  if (input.purpose === 'wallet_topup') return null;
  const [row] = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.userId, userId),
        eq(payments.purpose, input.purpose),
        eq(payments.purposeRefId, input.referenceId),
        eq(payments.method, 'bank_transfer'),
        eq(payments.status, 'pending'),
        isNotNull(payments.providerReference),
        // Leave the customer at least a few minutes to complete the transfer.
        gt(payments.expiresAt, new Date(Date.now() + 5 * 60_000)),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  const action = row ? bankTransferAction(row) : null;
  return row && action ? { payment: serializePayment(row), clientAction: action } : null;
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
  if (!awaitingMoney(payment)) return serializePayment(payment);
  let result: VerifyResult;
  try {
    result = await getPaymentProvider(payment.provider).verify(payment);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    logger.warn({ err, reference }, 'Payment status check failed');
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not check the payment status. Please try again.');
  }
  const settled = await settle(payment.id, result);
  return serializePayment(settled.status === 'pending' ? await expireIfLapsed(settled) : settled);
}

/**
 * "I've sent the money" on the bank-transfer screen. Records the claim (useful
 * for support if the transfer never arrives) and checks with Paystack at once.
 * The `charge.success` webhook confirms the payment whenever the money lands.
 */
export async function confirmTransferSent(userId: string, reference: string) {
  const payment = await getPayment(userId, reference);
  if (payment.method !== 'bank_transfer') {
    throw unprocessable('NOT_BANK_TRANSFER', 'This payment is not a bank transfer');
  }
  if (payment.status === 'pending' && !payment.customerConfirmedAt) {
    await db.update(payments).set({ customerConfirmedAt: new Date() }).where(eq(payments.id, payment.id));
  }
  try {
    return await verifyPayment(userId, reference);
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'PAYMENT_PROVIDER_ERROR')) throw err;
    return serializePayment(await getPayment(userId, reference));
  }
}

/** Closes a bank transfer whose account window (plus grace) has passed with no money received. */
async function expireIfLapsed(payment: PaymentRow): Promise<PaymentRow> {
  if (payment.method !== 'bank_transfer' || !payment.expiresAt) return payment;
  if (payment.expiresAt.getTime() + BANK_TRANSFER_GRACE_MINUTES * 60_000 > Date.now()) return payment;
  const failureReason = 'The transfer window expired before the payment arrived';
  await db
    .update(payments)
    .set({ status: 'cancelled', failureReason })
    .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')));
  const [row] = await db.select().from(payments).where(eq(payments.id, payment.id));
  return row!;
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
    // Already settled: idempotent no-op. The one exception: a bank transfer we expired
    // whose money still arrived. Money received is honoured, never dropped.
    const lateTransfer = payment.status === 'cancelled' && payment.method === 'bank_transfer' && result.outcome === 'succeeded';
    if (payment.status !== 'pending' && !lateTransfer) return payment;
    if (lateTransfer) logger.warn({ reference: payment.reference }, 'Bank transfer arrived after the payment was expired; settling it');

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
      case 'family_subscription':
        outcome = await confirmFamilySubscription(tx, payment.userId);
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

// ─── Reconciliation ──────────────────────────────────────────────────────────

/** Leave the first minutes to the app's own verify call and the webhook. */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;
/** Checkouts still unpaid after this are abandoned; a late webhook still settles them. */
export const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60_000;
const RECONCILE_BATCH = 50;

/**
 * Safety net for lost webhooks: asks the provider about recent payments that
 * are still awaiting money and settles them. This is what marks an appointment
 * or subscription paid when the app crashed mid-checkout and the webhook never
 * arrived. Runs on a timer (see server.ts); `settle` locks each row, so
 * overlapping runs or API instances settle a payment only once.
 *
 * Each checked row's `updatedAt` is bumped and rows are taken oldest-checked
 * first, so a large backlog is worked through in rotation.
 */
export async function reconcilePendingPayments(now = new Date()) {
  const rows = await db
    .select()
    .from(payments)
    .where(
      and(
        or(eq(payments.status, 'pending'), and(eq(payments.status, 'cancelled'), eq(payments.method, 'bank_transfer'))),
        lt(payments.createdAt, new Date(now.getTime() - RECONCILE_MIN_AGE_MS)),
        gt(payments.createdAt, new Date(now.getTime() - RECONCILE_WINDOW_MS)),
      ),
    )
    .orderBy(asc(payments.updatedAt))
    .limit(RECONCILE_BATCH);

  /** `succeeded`/`failed`: rows found in that state after the check (an overlapping run may have settled them). */
  const summary = { checked: 0, succeeded: 0, failed: 0, errors: 0 };
  for (const payment of rows) {
    summary.checked++;
    try {
      const result = await getPaymentProvider(payment.provider).verify(payment);
      const settled = await settle(payment.id, result);
      if (settled.status === 'pending') await expireIfLapsed(settled);
      if (settled.status === 'succeeded') summary.succeeded++;
      if (settled.status === 'failed') summary.failed++;
    } catch (err) {
      summary.errors++;
      logger.warn({ err, reference: payment.reference }, 'Payment reconciliation check failed');
    }
    await db.update(payments).set({ updatedAt: new Date() }).where(eq(payments.id, payment.id));
  }
  return summary;
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
      if (payment && awaitingMoney(payment)) {
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
