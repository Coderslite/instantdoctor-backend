import { z } from 'zod';
import { PAYOUT_STATUSES } from '../../db/schema/index.js';
import { payoutSettingsSchema } from './payouts.settings.js';

export const bankAccountSchema = z.object({
  bankCode: z.string().trim().min(2).max(32),
  accountNumber: z.string().trim().regex(/^\d{10}$/, 'Enter the 10-digit account number'),
});
export const payoutRequestSchema = z.object({ amount: z.coerce.number().positive().max(100_000_000) });
export const payoutListSchema = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
export const balancesListSchema = pageSchema.extend({ search: z.string().trim().max(100).optional() });
export const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const approveManySchema = z.object({ ids: z.array(z.string().min(1).max(36)).min(1).max(200) });
export const adjustmentSchema = z.object({ amount: z.coerce.number().refine((v) => v !== 0, 'Enter an amount other than zero').refine((v) => Math.abs(v) <= 100_000_000, 'Amount is too large'), reason: z.string().trim().min(3).max(255) });
export const settingsUpdateSchema = payoutSettingsSchema.partial().refine((v) => Object.keys(v).length > 0, 'At least one setting is required');
