import {
  bigint,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';

export const PAYMENT_PROVIDERS = ['stripe', 'paystack', 'flutterwave'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_PURPOSES = ['appointment', 'order_checkout', 'lab_result', 'wallet_topup'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * One row per payment attempt. `reference` is our merchant reference, sent to
 * the provider (Paystack `reference`, Flutterwave `tx_ref`, Stripe metadata) and
 * used to correlate webhooks. Amounts are fixed server-side at creation time.
 */
export const payments = mysqlTable(
  'payments',
  {
    id: id('id').primaryKey(),
    reference: varchar('reference', { length: 64 }).notNull(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    purpose: mysqlEnum('purpose', PAYMENT_PURPOSES).notNull(),
    purposeRefId: id('purpose_ref_id'),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    status: mysqlEnum('status', PAYMENT_STATUSES).notNull().default('pending'),

    baseAmount: money('base_amount').notNull(),
    surcharge: money('surcharge').notNull().default(0),
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    /** Amount in the provider's smallest unit at creation time (cents/kobo). */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),

    /** Provider-side id: Stripe PaymentIntent id, Flutterwave transaction id, Paystack id. */
    providerReference: varchar('provider_reference', { length: 128 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    failureReason: varchar('failure_reason', { length: 512 }),
    metadata: json('metadata').$type<Record<string, unknown>>(),
    paidAt: timestamp('paid_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_reference_uq').on(t.reference),
    uniqueIndex('payments_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('payments_purpose_idx').on(t.purpose, t.purposeRefId),
    index('payments_user_idx').on(t.userId, t.createdAt),
    index('payments_provider_ref_idx').on(t.provider, t.providerReference),
  ],
);

/** Inbound webhook log; the unique key makes redelivered events no-ops. */
export const paymentWebhookEvents = mysqlTable(
  'payment_webhook_events',
  {
    id: id('id').primaryKey(),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    eventId: varchar('event_id', { length: 191 }).notNull(),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    paymentReference: varchar('payment_reference', { length: 64 }),
    payload: json('payload').notNull(),
    processedAt: timestamp('processed_at'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payment_webhook_events_uq').on(t.provider, t.eventId)],
);

export const IDEMPOTENCY_STATES = ['in_progress', 'completed'] as const;

/**
 * Stored responses for `Idempotency-Key` requests (scoped per user + operation).
 * A retry with the same key and body replays the stored response; the same key
 * with a different body is rejected.
 */
export const idempotencyKeys = mysqlTable(
  'idempotency_keys',
  {
    userId: id('user_id').notNull(),
    scope: varchar('scope', { length: 64 }).notNull(),
    key: varchar('idempotency_key', { length: 128 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    state: mysqlEnum('state', IDEMPOTENCY_STATES).notNull().default('in_progress'),
    responseStatus: int('response_status'),
    responseBody: json('response_body'),
    lockedUntil: timestamp('locked_until').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scope, t.key] }),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
  ],
);

export const WALLET_TX_TYPES = ['credit', 'debit'] as const;

export const walletTransactions = mysqlTable(
  'wallet_transactions',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', WALLET_TX_TYPES).notNull(),
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    title: varchar('title', { length: 255 }).notNull(),
    balanceAfter: money('balance_after'),
    paymentId: id('payment_id'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('wallet_transactions_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('wallet_transactions_idempotency_uq').on(t.userId, t.idempotencyKey),
  ],
);

export const withdrawals = mysqlTable(
  'withdrawals',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    amount: money('amount').notNull(),
    bankName: varchar('bank_name', { length: 128 }),
    bankCode: varchar('bank_code', { length: 32 }),
    accountNumber: varchar('account_number', { length: 32 }),
    accountName: varchar('account_name', { length: 255 }),
    recipientCode: varchar('recipient_code', { length: 64 }),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [index('withdrawals_user_idx').on(t.userId)],
);
