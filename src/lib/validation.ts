import { z } from 'zod';
import { badRequest } from './errors.js';

/** Parse untrusted input against a schema, throwing a 400 with field-level issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest(
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/**
 * ISO-8601 timestamp with an explicit offset (`2026-10-03T10:00:00Z`, `...+01:00`),
 * parsed to a Date. Stricter than `z.coerce.date()` (which accepts numbers and
 * partial dates) and documents as `string` / `date-time` in OpenAPI.
 */
export const isoDateTime = () => z.iso.datetime({ offset: true }).transform((value) => new Date(value));
