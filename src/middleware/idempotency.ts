import { and, eq, lt } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema/index.js';
import { stableStringify, sha256 } from '../lib/crypto.js';
import { affectedRows, isDuplicateKeyError } from '../lib/db-errors.js';
import { badRequest, conflict, unauthorized, unprocessable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const HEADER = 'Idempotency-Key';
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
/** How long a key's stored response is replayable. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long an in-flight request owns its key before another attempt may take over. */
const LOCK_MS = 60 * 1000;

/**
 * Makes a mutating endpoint safe to retry (Stripe-style semantics):
 *
 * - First request with a key executes normally; its final response (< 500) is stored.
 * - A retry with the same key and the same body replays the stored response
 *   (`Idempotent-Replayed: true`) without executing the handler again.
 * - The same key with a different body is rejected with 422.
 * - A retry while the first request is still running gets 409 + `Retry-After`.
 * - 5xx responses are not stored, so the client can retry with the same key.
 *
 * Handlers that create rows should also persist `req.idempotencyKey` under a
 * unique constraint, so a crash between commit and response storage can never
 * produce a duplicate.
 */
export function idempotent(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.userId;
    if (!userId) throw unauthorized();

    const key = req.header(HEADER);
    if (!key) throw badRequest(`${HEADER} header is required for this operation`);
    if (!KEY_PATTERN.test(key)) {
      throw badRequest(`${HEADER} must be 8-128 characters of [A-Za-z0-9_.:-]`);
    }

    const requestHash = sha256(
      stableStringify({ method: req.method, path: req.baseUrl + req.path, body: req.body ?? null }),
    );
    const pk = and(
      eq(idempotencyKeys.userId, userId),
      eq(idempotencyKeys.scope, scope),
      eq(idempotencyKeys.key, key),
    );

    const acquired = await acquire(userId, scope, key, requestHash);
    if (!acquired) {
      const [existing] = await db.select().from(idempotencyKeys).where(pk).limit(1);
      if (!existing) {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'Request is being processed; retry shortly');
      }
      if (existing.requestHash !== requestHash) {
        throw unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          `${HEADER} was already used with a different request body`,
        );
      }
      if (existing.state === 'completed') {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus ?? 200).json(existing.responseBody);
        return;
      }
      if (existing.lockedUntil > new Date()) {
        res.setHeader('Retry-After', Math.ceil((existing.lockedUntil.getTime() - Date.now()) / 1000));
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is still being processed');
      }
      // The previous attempt died mid-flight. Take over its lock with a compare-and-set.
      const takeover = await db
        .update(idempotencyKeys)
        .set({ lockedUntil: new Date(Date.now() + LOCK_MS) })
        .where(and(pk, eq(idempotencyKeys.state, 'in_progress'), eq(idempotencyKeys.lockedUntil, existing.lockedUntil)));
      if (affectedRows(takeover) === 0) {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is still being processed');
      }
    }

    req.idempotencyKey = key;
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const persist =
        status < 500
          ? db
              .update(idempotencyKeys)
              .set({ state: 'completed', responseStatus: status, responseBody: body ?? null })
              .where(pk)
          : db.delete(idempotencyKeys).where(pk);
      persist
        .catch((err: unknown) => logger.error({ err, scope, key }, 'Failed to persist idempotency record'))
        .finally(() => sendJson(body));
      return res;
    };

    next();
  };
}

async function acquire(userId: string, scope: string, key: string, requestHash: string) {
  const now = Date.now();
  const values = {
    userId,
    scope,
    key,
    requestHash,
    state: 'in_progress' as const,
    lockedUntil: new Date(now + LOCK_MS),
    expiresAt: new Date(now + RETENTION_MS),
  };
  try {
    await db.insert(idempotencyKeys).values(values);
    return true;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }
  // Expired keys are reusable: clear the stale row and try once more.
  const removed = await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.key, key),
        lt(idempotencyKeys.expiresAt, new Date(now)),
      ),
    );
  if (affectedRows(removed) === 0) return false;
  try {
    await db.insert(idempotencyKeys).values(values);
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Housekeeping: drop expired records. Called periodically from the server. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date()));
  return affectedRows(result);
}
