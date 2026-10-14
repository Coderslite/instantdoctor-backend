import { z } from 'zod';
import { PAYOUT_STATUSES } from '../../db/schema/index.js';

const currency = z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a 3-letter currency code').transform((v) => v.toUpperCase());

/** A Nigerian account (checked with the bank), or an account abroad paid manually. */
export const bankAccountSchema = z.union([
  z.object({
    bankCode: z.string().trim().min(2).max(32),
    accountNumber: z.string().trim().regex(/^\d{10}$/, 'Enter the 10-digit account number'),
  }),
  z.object({
    bankName: z.string().trim().min(2).max(128),
    accountNumber: z.string().trim().min(4).max(32),
    accountName: z.string().trim().min(2).max(255),
  }),
]);
export const payoutRequestSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  currency: currency.default('NGN'),
});
export const payoutListSchema = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export const balancesListSchema = pageSchema.extend({ search: z.string().trim().max(100).optional() });
export const approveSchema = z.object({ paymentReference: z.string().trim().max(120).nullish() });
export const adjustmentSchema = z.object({
  amount: z.coerce
    .number()
    .refine((v) => v !== 0, 'Enter an amount other than zero')
    .refine((v) => Math.abs(v) <= 100_000_000, 'Amount is too large'),
  currency: currency.default('NGN'),
  reason: z.string().trim().min(3).max(255),
});
