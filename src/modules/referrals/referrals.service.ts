import { and, count, desc, eq, gte, lt, sum } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { referrals, users } from '../../db/schema/index.js';

/** Referrals made by the caller in a calendar month (UTC), newest first. */
export async function listReferrals(userId: string, month = new Date()) {
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  return db
    .select({
      id: referrals.id,
      status: referrals.status,
      totalCommissionEarned: referrals.totalCommissionEarned,
      createdAt: referrals.createdAt,
      referredUser: { id: users.id, firstName: users.firstName, lastName: users.lastName, photoUrl: users.photoUrl },
    })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.userId))
    .where(and(eq(referrals.referrerId, userId), gte(referrals.createdAt, start), lt(referrals.createdAt, end)))
    .orderBy(desc(referrals.createdAt));
}

export async function referralSummary(userId: string) {
  const [[agg], [me]] = await Promise.all([
    db
      .select({ total: count(), earned: sum(referrals.totalCommissionEarned) })
      .from(referrals)
      .where(eq(referrals.referrerId, userId)),
    db.select({ balance: users.referralBalance, tag: users.tag }).from(users).where(eq(users.id, userId)),
  ]);
  return {
    tag: me?.tag ?? null,
    referralCount: agg?.total ?? 0,
    totalEarned: Number(agg?.earned ?? 0),
    balance: me?.balance ?? 0,
  };
}
