import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { notifications, type NotificationType } from '../../db/schema/index.js';
import { newId } from '../../lib/ids.js';
import type { Pagination } from '../../lib/pagination.js';
import { realtime } from '../../realtime/gateway.js';

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  uniqueId?: string | null;
}

/**
 * Persists an in-app notification. Pass a transaction to make it atomic with
 * the business change; emit the realtime event after commit via the returned callback.
 */
export async function createNotification(input: NewNotification, executor: Executor = db) {
  const row = {
    id: newId(),
    userId: input.userId,
    type: input.type,
    title: input.title,
    uniqueId: input.uniqueId ?? null,
    status: 'delivered' as const,
    createdAt: new Date(),
  };
  await executor.insert(notifications).values(row);
  return () =>
    realtime.toUser(row.userId, 'notification:new', {
      id: row.id,
      type: row.type,
      title: row.title,
      createdAt: row.createdAt,
    });
}

export function listNotifications(userId: string, { limit, offset }: Pagination) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), ne(notifications.status, 'read')));
  return Number(row?.count ?? 0);
}

export async function markAllRead(userId: string) {
  await db
    .update(notifications)
    .set({ status: 'read' })
    .where(and(eq(notifications.userId, userId), ne(notifications.status, 'read')));
}
