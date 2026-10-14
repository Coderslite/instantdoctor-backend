import { index, int, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { PAYOUT_STATUSES } from './pharmacy.js';
import { users } from './users.js';

/**
 * Doctor pay. Every completed paid consultation credits the doctor's ledger
 * with its earning (in the doctor's earning currency); payouts debit it. A
 * doctor's balance in a currency is the sum of their entries in it, and
 * `available_at` holds new earnings back for a short clearing period.
 */
export const DOCTOR_LEDGER_TYPES = ['earning', 'earning_reversal', 'payout', 'payout_reversal', 'adjustment'] as const;
export type DoctorLedgerType = (typeof DOCTOR_LEDGER_TYPES)[number];

export const doctorLedger = mysqlTable(
  'doctor_ledger',
  {
    id: id('id').primaryKey(),
    doctorId: id('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', DOCTOR_LEDGER_TYPES).notNull(),
    /** Signed: earnings and returned payouts are positive, payouts and reversals negative. */
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    appointmentId: id('appointment_id'),
    payoutId: id('payout_id'),
    createdBy: varchar('created_by', { length: 255 }),
    availableAt: timestamp('available_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('doctor_ledger_doctor_idx').on(t.doctorId, t.currency, t.createdAt),
    index('doctor_ledger_appointment_idx').on(t.appointmentId),
    index('doctor_ledger_payout_idx').on(t.payoutId),
  ],
);

/** paystack: sent by bank transfer (NGN accounts). manual: paid outside the app (e.g. foreign accounts) and recorded by an admin. */
export const DOCTOR_PAYOUT_METHODS = ['paystack', 'manual'] as const;

export const doctorPayouts = mysqlTable(
  'doctor_payouts',
  {
    id: id('id').primaryKey(),
    doctorId: id('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Our transfer reference, also sent to Paystack. */
    reference: varchar('reference', { length: 50 }).notNull(),
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    method: mysqlEnum('method', DOCTOR_PAYOUT_METHODS).notNull(),
    trigger: mysqlEnum('trigger', ['on_demand', 'scheduled']).notNull(),
    status: mysqlEnum('status', PAYOUT_STATUSES).notNull().default('pending_approval'),
    bankName: varchar('bank_name', { length: 128 }).notNull(),
    accountNumber: varchar('account_number', { length: 32 }).notNull(),
    accountName: varchar('account_name', { length: 255 }).notNull(),
    recipientCode: varchar('recipient_code', { length: 64 }),
    requestedBy: varchar('requested_by', { length: 255 }).notNull(),
    approvedBy: varchar('approved_by', { length: 255 }),
    approvedAt: timestamp('approved_at'),
    transferCode: varchar('transfer_code', { length: 64 }),
    /** Manual payouts: the admin's bank or transfer reference. */
    paymentReference: varchar('payment_reference', { length: 120 }),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    lastError: varchar('last_error', { length: 500 }),
    paidAt: timestamp('paid_at'),
    runId: id('run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('doctor_payouts_reference_uq').on(t.reference),
    index('doctor_payouts_doctor_idx').on(t.doctorId, t.createdAt),
    index('doctor_payouts_status_idx').on(t.status, t.createdAt),
  ],
);

/** One row per weekly run, so a week is never paid twice. */
export const doctorPayoutRuns = mysqlTable(
  'doctor_payout_runs',
  {
    id: id('id').primaryKey(),
    runKey: varchar('run_key', { length: 64 }).notNull(),
    startedBy: varchar('started_by', { length: 255 }).notNull(),
    payoutCount: int('payout_count').notNull().default(0),
    /** Total per currency, e.g. { NGN: 120000 }. */
    totals: json('totals').$type<Record<string, number>>(),
    completedAt: timestamp('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('doctor_payout_runs_key_uq').on(t.runKey)],
);
