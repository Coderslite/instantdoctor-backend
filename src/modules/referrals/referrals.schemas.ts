import { z } from 'zod';

export const listReferralsQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM').optional(),
});
