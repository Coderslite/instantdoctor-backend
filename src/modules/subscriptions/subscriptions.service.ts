import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { db } from '../../db/client.js';
import { familySubscriptions, users } from '../../db/schema/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { AFRICAN_COUNTRIES } from '../pricing/pricing.service.js';

export const FAMILY_CARE_MONTHLY_NGN = 5000;
export const FAMILY_CARE_MONTHLY_USD = 10;
export const FAMILY_CARE_CREDITS_PER_MONTH = 1;
const TRIAL_DAYS = 7;

const endsInDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const endsInMonth = () => endsInDays(30);

function current(row: typeof familySubscriptions.$inferSelect, now = new Date()) {
  return (row.status === 'trialing' && row.trialEndsAt > now) ||
    (row.status === 'active' && !!row.currentPeriodEnd && row.currentPeriodEnd > now);
}

export function serializeFamilySubscription(row: typeof familySubscriptions.$inferSelect, african: boolean) {
  const active = current(row);
  const isPaid = row.status === 'active' && !!row.currentPeriodEnd && row.currentPeriodEnd > new Date();
  return {
    id: row.id,
    status: active ? row.status : 'expired',
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
    consultationCreditsTotal: isPaid ? FAMILY_CARE_CREDITS_PER_MONTH : 0,
    consultationCreditsRemaining: isPaid ? Math.max(0, FAMILY_CARE_CREDITS_PER_MONTH - row.consultationCreditsUsed) : 0,
    price: { amount: african ? FAMILY_CARE_MONTHLY_NGN : FAMILY_CARE_MONTHLY_USD, currency: african ? 'NGN' : 'USD' },
    canManageFamily: active,
  };
}

async function region(userId: string) {
  const [user] = await db.select({ country: users.country }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound('User');
  return AFRICAN_COUNTRIES.has(user.country?.toUpperCase() ?? '');
}

export async function familySubscriptionPrice(userId: string) {
  const african = await region(userId);
  return {
    amount: african ? FAMILY_CARE_MONTHLY_NGN : FAMILY_CARE_MONTHLY_USD,
    currency: african ? 'NGN' : 'USD',
  };
}

export async function getFamilySubscription(userId: string) {
  const african = await region(userId);
  const [row] = await db.select().from(familySubscriptions).where(eq(familySubscriptions.userId, userId));
  if (!row) return { subscription: null, price: { amount: african ? FAMILY_CARE_MONTHLY_NGN : FAMILY_CARE_MONTHLY_USD, currency: african ? 'NGN' : 'USD' } };
  return { subscription: serializeFamilySubscription(row, african), price: { amount: african ? FAMILY_CARE_MONTHLY_NGN : FAMILY_CARE_MONTHLY_USD, currency: african ? 'NGN' : 'USD' } };
}

export async function startFamilyTrial(userId: string) {
  const african = await region(userId);
  const [existing] = await db.select().from(familySubscriptions).where(eq(familySubscriptions.userId, userId));
  if (existing) throw conflict('FAMILY_TRIAL_ALREADY_USED', 'Your Family Care trial has already been used');
  const now = new Date();
  const row = { id: newId(), userId, status: 'trialing' as const, trialStartedAt: now, trialEndsAt: endsInDays(TRIAL_DAYS) };
  await db.insert(familySubscriptions).values(row);
  return serializeFamilySubscription({ ...row, currentPeriodStart: null, currentPeriodEnd: null, consultationCreditsUsed: 0, createdAt: now, updatedAt: now }, african);
}

export async function requireFamilySubscription(userId: string, id: string) {
  const [sub] = await db
    .select({ id: familySubscriptions.id })
    .from(familySubscriptions)
    .where(and(eq(familySubscriptions.id, id), eq(familySubscriptions.userId, userId)))
    .limit(1);
  if (!sub) throw notFound('Family Care subscription');
  return sub;
}

export async function requireFamilyCareAccess(userId: string) {
  const [sub] = await db.select().from(familySubscriptions).where(eq(familySubscriptions.userId, userId)).limit(1);
  if (!sub || !current(sub)) {
    throw conflict('FAMILY_SUBSCRIPTION_REQUIRED', 'Start or renew Family Care to add family members');
  }
  return sub;
}

export async function requireAvailableFamilyCredit(tx: Tx, userId: string) {
  const [sub] = await tx.select().from(familySubscriptions).where(eq(familySubscriptions.userId, userId)).for('update');
  if (!sub || sub.status !== 'active' || !sub.currentPeriodEnd || sub.currentPeriodEnd <= new Date()) {
    throw conflict('FAMILY_SUBSCRIPTION_REQUIRED', 'An active Family Care membership is required for this consultation credit');
  }
  if (sub.consultationCreditsUsed >= FAMILY_CARE_CREDITS_PER_MONTH) {
    throw conflict('FAMILY_CREDIT_USED', 'Your shared Family Care consultation credit has been used this month');
  }
  await tx.update(familySubscriptions).set({ consultationCreditsUsed: sub.consultationCreditsUsed + 1 }).where(eq(familySubscriptions.id, sub.id));
  return sub;
}

/** Called exclusively after a verified Family Care payment. */
export async function activateFamilySubscription(tx: Tx, userId: string) {
  const [sub] = await tx.select().from(familySubscriptions).where(eq(familySubscriptions.userId, userId)).for('update');
  const now = new Date();
  if (!sub) {
    const id = newId();
    await tx.insert(familySubscriptions).values({ id, userId, status: 'active', trialStartedAt: now, trialEndsAt: now, currentPeriodStart: now, currentPeriodEnd: endsInMonth(), consultationCreditsUsed: 0 });
    return id;
  }
  const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const periodEnd = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
  await tx.update(familySubscriptions).set({ status: 'active', currentPeriodStart: now, currentPeriodEnd: periodEnd, consultationCreditsUsed: 0 }).where(eq(familySubscriptions.id, sub.id));
  return sub.id;
}
