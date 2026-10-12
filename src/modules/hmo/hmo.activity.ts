import { and, count, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { admins, hmoActivity, type HmoActivityActor } from '../../db/schema/index.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import type { activityQuery } from './hmo.schemas.js';

/**
 * The HMO's activity trail: every change to its members, team, agreement and
 * billing, by its own people or by Instant Doctor staff. Both sides read it.
 */

export interface Actor {
  type: HmoActivityActor;
  id: string | null;
  name: string;
}

export interface ActivityEvent {
  action: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

export async function adminActor(adminId: string): Promise<Actor> {
  const [admin] = await db
    .select({ name: admins.name })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  return { type: 'admin', id: adminId, name: admin?.name ?? 'Instant Doctor' };
}

/**
 * Called after the change has been committed. A failure here is logged rather
 * than thrown: failing the request would invite a retry of a change that
 * already happened.
 */
export async function recordActivity(hmoId: string, actor: Actor, event: ActivityEvent) {
  try {
    await db.insert(hmoActivity).values({
      id: newId(),
      hmoId,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name.slice(0, 200),
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      summary: event.summary.slice(0, 500),
      details: event.details ?? null,
    });
  } catch (err) {
    logger.error({ err, hmoId, action: event.action }, 'Failed to record HMO activity');
  }
}

export type Change = { from: unknown; to: unknown };

/** Fields whose value differs between two versions of a record, as `{ field: { from, to } }`. */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: ReadonlyArray<keyof T & string>,
): Record<string, Change> {
  const plain = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
  const changes: Record<string, Change> = {};
  for (const field of fields) {
    const [from, to] = [plain(before[field]), plain(after[field])];
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

/**
 * "status active → suspended, cover ends" — status-like fields show both
 * values; the rest are named, with the values kept in the event details.
 */
export function describeChanges(
  changes: Record<string, Change>,
  labels: Record<string, string>,
  showValues: readonly string[] = ['status', 'role', 'isActive'],
): string {
  return Object.entries(changes)
    .map(([field, { from, to }]) => {
      const label = labels[field] ?? field;
      return showValues.includes(field) ? `${label} ${String(from)} → ${String(to)}` : label;
    })
    .join(', ');
}

export async function listActivity(hmoId: string, query: z.infer<typeof activityQuery>) {
  const where = and(
    eq(hmoActivity.hmoId, hmoId),
    query.entityType ? eq(hmoActivity.entityType, query.entityType) : undefined,
    query.entityId ? eq(hmoActivity.entityId, query.entityId) : undefined,
    query.actorType ? eq(hmoActivity.actorType, query.actorType) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select({
        id: hmoActivity.id,
        actorType: hmoActivity.actorType,
        actorName: hmoActivity.actorName,
        action: hmoActivity.action,
        entityType: hmoActivity.entityType,
        entityId: hmoActivity.entityId,
        summary: hmoActivity.summary,
        details: hmoActivity.details,
        createdAt: hmoActivity.createdAt,
      })
      .from(hmoActivity)
      .where(where)
      .orderBy(desc(hmoActivity.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(hmoActivity).where(where),
  ]);
  return { items, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}
