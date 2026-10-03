import { z } from 'zod';

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function page<T>(items: T[], { limit, offset }: Pagination) {
  return { items, limit, offset, nextOffset: items.length === limit ? offset + limit : null };
}
