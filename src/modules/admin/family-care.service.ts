import { and, count, desc, eq, gt, inArray, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appointments, familyProfiles, familySubscriptions, payments, users } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { AFRICAN_COUNTRIES } from '../pricing/pricing.service.js';
import {
  FAMILY_CARE_CREDITS_PER_MONTH,
  FAMILY_CARE_MONTHLY_NGN,
  FAMILY_CARE_MONTHLY_USD,
} from '../subscriptions/subscriptions.service.js';

/**
 * Family Care members for the admin. A membership's stored status lags behind
 * time (an "active" row whose month ran out is over), so the state shown here
 * is worked out from the dates:
 * - active: paid, and the paid month hasn't ended
 * - trialing: in the free trial
 * - expired: trial or paid month over and not renewed
 */
export const FAMILY_CARE_STATES = ['active', 'trialing', 'expired'] as const;
export type FamilyCareState = (typeof FAMILY_CARE_STATES)[number];

const nowSql = () => sql`UTC_TIMESTAMP(3)`;
const isActive = () => and(eq(familySubscriptions.status, 'active'), gt(familySubscriptions.currentPeriodEnd, nowSql()))!;
const isTrialing = () => and(eq(familySubscriptions.status, 'trialing'), gt(familySubscriptions.trialEndsAt, nowSql()))!;
const isExpired = () => and(sql`NOT (${isActive()})`, sql`NOT (${isTrialing()})`)!;
const STATE_FILTER: Record<FamilyCareState, () => SQL> = { active: isActive, trialing: isTrialing, expired: isExpired };

const stateOf = (row: { status: string; currentPeriodEnd: Date | null; trialEndsAt: Date }, now = new Date()): FamilyCareState =>
  row.status === 'active' && row.currentPeriodEnd && row.currentPeriodEnd > now
    ? 'active'
    : row.status === 'trialing' && row.trialEndsAt > now
      ? 'trialing'
      : 'expired';

/** The monthly price this member pays: naira in Africa, dollars elsewhere. */
const priceFor = (country: string | null) =>
  AFRICAN_COUNTRIES.has(country?.toUpperCase() ?? '')
    ? { amount: FAMILY_CARE_MONTHLY_NGN, currency: 'NGN' }
    : { amount: FAMILY_CARE_MONTHLY_USD, currency: 'USD' };

const fullName = sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`;

/** Paid Family Care payments per member, per currency. */
const paidSoFar = (userIds: string[]) =>
  userIds.length
    ? db
        .select({
          userId: payments.userId,
          currency: payments.currency,
          total: sql<string>`SUM(${payments.amount})`,
          count: count(),
          lastPaidAt: sql<Date | null>`MAX(${payments.paidAt})`,
        })
        .from(payments)
        .where(and(eq(payments.purpose, 'family_subscription'), eq(payments.status, 'succeeded'), inArray(payments.userId, userIds)))
        .groupBy(payments.userId, payments.currency)
    : Promise.resolve([]);

export async function listFamilyCare(query: { state?: FamilyCareState; search?: string; limit: number; offset: number }) {
  const filters: SQL[] = [];
  if (query.state) filters.push(STATE_FILTER[query.state]());
  if (query.search) {
    const term = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    filters.push(or(like(fullName, term), like(users.email, term), like(users.phoneNumber, term))!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const memberCount = sql<number>`(SELECT COUNT(*) FROM ${familyProfiles} WHERE ${familyProfiles.ownerUserId} = ${familySubscriptions.userId})`;

  const [rows, [total], states, endingSoon] = await Promise.all([
    db
      .select({
        sub: familySubscriptions,
        name: fullName,
        email: users.email,
        phoneNumber: users.phoneNumber,
        country: users.country,
        familyMembers: memberCount,
      })
      .from(familySubscriptions)
      .innerJoin(users, eq(users.id, familySubscriptions.userId))
      .where(where)
      // Paying members first, then trials, newest first within each.
      .orderBy(
        sql`CASE WHEN ${isActive()} THEN 0 WHEN ${isTrialing()} THEN 1 ELSE 2 END`,
        desc(sql`COALESCE(${familySubscriptions.currentPeriodStart}, ${familySubscriptions.trialStartedAt})`),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(familySubscriptions).innerJoin(users, eq(users.id, familySubscriptions.userId)).where(where),
    db
      .select({
        active: sql<number>`SUM(CASE WHEN ${isActive()} THEN 1 ELSE 0 END)`,
        trialing: sql<number>`SUM(CASE WHEN ${isTrialing()} THEN 1 ELSE 0 END)`,
        total: count(),
        everPaid: sql<number>`(SELECT COUNT(DISTINCT ${payments.userId}) FROM ${payments} WHERE ${payments.purpose} = 'family_subscription' AND ${payments.status} = 'succeeded')`,
      })
      .from(familySubscriptions),
    // Paid members whose month ends in the next 7 days: worth a reminder.
    db
      .select({ value: count() })
      .from(familySubscriptions)
      .where(and(isActive(), lte(familySubscriptions.currentPeriodEnd, sql`DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY)`))),
  ]);

  // Monthly income from paying members, per currency (naira in Africa, dollars elsewhere).
  const payingCountries = await db
    .select({ country: users.country, n: count() })
    .from(familySubscriptions)
    .innerJoin(users, eq(users.id, familySubscriptions.userId))
    .where(isActive())
    .groupBy(users.country);
  const monthlyIncome: Record<string, number> = {};
  for (const r of payingCountries) {
    const price = priceFor(r.country);
    monthlyIncome[price.currency] = round2((monthlyIncome[price.currency] ?? 0) + price.amount * Number(r.n));
  }

  const paid = await paidSoFar(rows.map((r) => r.sub.userId));
  const s = states[0];
  return {
    summary: {
      active: Number(s?.active ?? 0),
      trialing: Number(s?.trialing ?? 0),
      expired: Number(s?.total ?? 0) - Number(s?.active ?? 0) - Number(s?.trialing ?? 0),
      total: Number(s?.total ?? 0),
      /** Ever paid at least once, against everyone who started (trial or paid). */
      everPaid: Number(s?.everPaid ?? 0),
      endingThisWeek: endingSoon[0]?.value ?? 0,
      monthlyIncome,
    },
    items: rows.map((r) => {
      const mine = paid.filter((p) => p.userId === r.sub.userId);
      return {
        id: r.sub.id,
        userId: r.sub.userId,
        name: r.name,
        email: r.email,
        phoneNumber: r.phoneNumber,
        country: r.country,
        state: stateOf(r.sub),
        price: priceFor(r.country),
        trialStartedAt: r.sub.trialStartedAt,
        trialEndsAt: r.sub.trialEndsAt,
        currentPeriodStart: r.sub.currentPeriodStart,
        currentPeriodEnd: r.sub.currentPeriodEnd,
        creditsUsed: r.sub.consultationCreditsUsed,
        creditsPerMonth: FAMILY_CARE_CREDITS_PER_MONTH,
        familyMembers: Number(r.familyMembers),
        payments: mine.reduce((n, p) => n + Number(p.count), 0),
        totalPaid: Object.fromEntries(mine.map((p) => [p.currency, round2(Number(p.total))])),
        lastPaidAt: mine.reduce<Date | null>((latest, p) => (p.lastPaidAt && (!latest || new Date(p.lastPaidAt) > latest) ? new Date(p.lastPaidAt) : latest), null),
        createdAt: r.sub.createdAt,
      };
    }),
    total: total?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** One membership: the member, their family, every payment and the visits used. */
export async function getFamilyCare(id: string) {
  const [row] = await db
    .select({ sub: familySubscriptions, name: fullName, email: users.email, phoneNumber: users.phoneNumber, country: users.country })
    .from(familySubscriptions)
    .innerJoin(users, eq(users.id, familySubscriptions.userId))
    .where(eq(familySubscriptions.id, id))
    .limit(1);
  if (!row) throw notFound('Family Care membership');
  const userId = row.sub.userId;
  const [family, paymentRows, visits] = await Promise.all([
    db
      .select({
        id: familyProfiles.id,
        name: familyProfiles.name,
        relationship: familyProfiles.relationship,
        dateOfBirth: familyProfiles.dateOfBirth,
        sex: familyProfiles.sex,
        createdAt: familyProfiles.createdAt,
      })
      .from(familyProfiles)
      .where(eq(familyProfiles.ownerUserId, userId))
      .orderBy(familyProfiles.createdAt, familyProfiles.name),
    db
      .select({
        id: payments.id,
        reference: payments.reference,
        status: payments.status,
        amount: payments.amount,
        currency: payments.currency,
        provider: payments.provider,
        method: payments.method,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(eq(payments.userId, userId), eq(payments.purpose, 'family_subscription')))
      .orderBy(desc(payments.createdAt))
      .limit(100),
    db
      .select({
        id: appointments.id,
        status: appointments.status,
        packageLabel: appointments.packageLabel,
        startTime: appointments.startTime,
        doctorEarning: appointments.doctorEarning,
        currency: appointments.currency,
      })
      .from(appointments)
      .where(and(eq(appointments.userId, userId), eq(appointments.isSubscriptionCredit, true)))
      .orderBy(desc(appointments.startTime))
      .limit(50),
  ]);
  return {
    id: row.sub.id,
    userId,
    name: row.name,
    email: row.email,
    phoneNumber: row.phoneNumber,
    country: row.country,
    state: stateOf(row.sub),
    price: priceFor(row.country),
    trialStartedAt: row.sub.trialStartedAt,
    trialEndsAt: row.sub.trialEndsAt,
    currentPeriodStart: row.sub.currentPeriodStart,
    currentPeriodEnd: row.sub.currentPeriodEnd,
    creditsUsed: row.sub.consultationCreditsUsed,
    creditsPerMonth: FAMILY_CARE_CREDITS_PER_MONTH,
    createdAt: row.sub.createdAt,
    family,
    payments: paymentRows,
    visits,
  };
}
