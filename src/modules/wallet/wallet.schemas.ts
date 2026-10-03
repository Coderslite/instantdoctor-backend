import { z } from 'zod';
import { paginationQuery } from '../../lib/pagination.js';

export const listTransactionsQuery = paginationQuery.extend({ type: z.enum(['credit', 'debit']).optional() });

export const transferSchema = z.object({
  email: z.email().trim().toLowerCase(),
  amount: z.number().positive().max(10_000_000).multipleOf(0.01),
});
