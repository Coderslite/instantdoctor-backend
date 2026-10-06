import { and, count, desc, eq, gte, lt, sum } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { referrals, users } from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';

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

/** How long after sign-up a user may still enter a referral code. */
export const REFERRAL_CLAIM_WINDOW_DAYS = 7;

/**
 * Whether the caller can still enter a referral code. Closed once they have a
 * referrer, after the window, or after their first paid booking (the
 * commission is earned on that booking, so a later code would earn nothing).
 */
export async function getMyReferral(userId: string) {
  const [[user], [referral]] = await Promise.all([
    db.select({ createdAt: users.createdAt, hasPaid: users.hasPaid }).from(users).where(eq(users.id, userId)),
    db.select({ referrerTag: referrals.referrerTag }).from(referrals).where(eq(referrals.userId, userId)),
  ]);
  if (!user) throw notFound('User');
  const applyBefore = new Date(user.createdAt.getTime() + REFERRAL_CLAIM_WINDOW_DAYS * 86_400_000);
  return {
    referredBy: referral?.referrerTag ?? null,
    canApplyCode: !referral && !user.hasPaid && applyBefore > new Date(),
    applyBefore,
  };
}

/** Records who referred the caller. Allowed once, within the claim window, before the first paid booking. */
export async function applyReferralCode(userId: string, code: string) {
  const state = await getMyReferral(userId);
  if (state.referredBy) throw conflict('ALREADY_REFERRED', 'A referral code has already been applied to your account');
  if (!state.canApplyCode) {
    throw unprocessable(
      'REFERRAL_WINDOW_CLOSED',
      `Referral codes can only be added within ${REFERRAL_CLAIM_WINDOW_DAYS} days of sign-up and before your first paid consultation`,
    );
  }

  const [referrer] = await db.select({ id: users.id }).from(users).where(eq(users.tag, code)).limit(1);
  if (!referrer) throw badRequest('This referral code does not exist', [{ path: 'code', message: 'unknown code' }]);
  if (referrer.id === userId) throw badRequest('You cannot use your own referral code');

  try {
    await db.insert(referrals).values({ id: newId(), userId, referrerTag: code, referrerId: referrer.id });
  } catch (err) {
    // A concurrent request applied a code first (UNIQUE on referrals.user_id).
    if (isDuplicateKeyError(err)) throw conflict('ALREADY_REFERRED', 'A referral code has already been applied to your account');
    throw err;
  }
  return getMyReferral(userId);
}
