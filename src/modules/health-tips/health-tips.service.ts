import { and, count, desc, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { healthTipCategories, healthTipLikes, healthTipViews, healthTips } from '../../db/schema/index.js';
import { affectedRows } from '../../lib/db-errors.js';
import { notFound } from '../../lib/errors.js';

const published = () => and(isNotNull(healthTips.publishedAt), lte(healthTips.publishedAt, new Date()));

const summary = {
  id: healthTips.id,
  categoryId: healthTips.categoryId,
  title: healthTips.title,
  slug: healthTips.slug,
  image: healthTips.image,
  type: healthTips.type,
  views: healthTips.views,
  publishedAt: healthTips.publishedAt,
};

export async function listCategories() {
  return db
    .select({
      id: healthTipCategories.id,
      name: healthTipCategories.name,
      image: healthTipCategories.image,
      articleCount: sql<number>`count(${healthTips.id})`,
    })
    .from(healthTipCategories)
    .leftJoin(healthTips, and(eq(healthTips.categoryId, healthTipCategories.id), published()))
    .groupBy(healthTipCategories.id)
    .orderBy(healthTipCategories.name);
}

export function listTips(query: { categoryId?: string; limit: number; offset: number }) {
  return db
    .select(summary)
    .from(healthTips)
    .where(and(published(), query.categoryId ? eq(healthTips.categoryId, query.categoryId) : undefined))
    .orderBy(desc(healthTips.publishedAt))
    .limit(query.limit)
    .offset(query.offset);
}

/** Returns the full article and records a unique view for the reader. */
export async function readTip(userId: string, tipId: string) {
  const [tip] = await db.select().from(healthTips).where(and(eq(healthTips.id, tipId), published())).limit(1);
  if (!tip) throw notFound('Health tip');

  const inserted = await db.insert(healthTipViews).ignore().values({ healthTipId: tipId, userId });
  if (affectedRows(inserted) > 0) {
    await db.update(healthTips).set({ views: sql`${healthTips.views} + 1` }).where(eq(healthTips.id, tipId));
    tip.views += 1;
  }
  const [[likes], [mine]] = await Promise.all([
    db.select({ n: count() }).from(healthTipLikes).where(eq(healthTipLikes.healthTipId, tipId)),
    db
      .select({ n: count() })
      .from(healthTipLikes)
      .where(and(eq(healthTipLikes.healthTipId, tipId), eq(healthTipLikes.userId, userId))),
  ]);
  return { ...tip, likeCount: likes?.n ?? 0, likedByMe: (mine?.n ?? 0) > 0 };
}

export async function relatedTips(tipId: string, limit = 5) {
  const [tip] = await db.select({ categoryId: healthTips.categoryId }).from(healthTips).where(eq(healthTips.id, tipId));
  if (!tip?.categoryId) return [];
  return db
    .select(summary)
    .from(healthTips)
    .where(and(published(), eq(healthTips.categoryId, tip.categoryId), ne(healthTips.id, tipId)))
    .orderBy(desc(healthTips.publishedAt))
    .limit(limit);
}

/** Toggles the caller's like; returns the new state. */
export async function toggleLike(userId: string, tipId: string) {
  const removed = await db
    .delete(healthTipLikes)
    .where(and(eq(healthTipLikes.healthTipId, tipId), eq(healthTipLikes.userId, userId)));
  if (affectedRows(removed) > 0) return { liked: false };
  const [exists] = await db.select({ id: healthTips.id }).from(healthTips).where(eq(healthTips.id, tipId));
  if (!exists) throw notFound('Health tip');
  await db.insert(healthTipLikes).ignore().values({ healthTipId: tipId, userId });
  return { liked: true };
}
