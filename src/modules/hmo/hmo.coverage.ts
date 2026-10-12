import { and, count, eq, gt, gte, isNull, ne, notInArray, or, sql, sum, type SQL } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client.js';
import {
  appointments,
  hmoClaims,
  hmoEnrollees,
  hmoPlanRules,
  hmoPlans,
  hmos,
  labResults,
  orders,
  users,
  type HmoService,
} from '../../db/schema/index.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { round2 } from '../../lib/money.js';
import { toE164 } from '../../lib/phone.js';
import { getFeePolicy } from '../pricing/fees.js';
import { applyRule, describeRule, type CoverageAmounts } from './hmo.pricing.js';

/**
 * The runtime side of HMO agreements: who is covered, which rule applies and
 * what it costs. Booking and lab-result pricing call `coverageFor`; when it
 * returns a decision, they charge `patientAmount` and call `recordClaim`.
 */

type Rule = typeof hmoPlanRules.$inferSelect;
type Plan = typeof hmoPlans.$inferSelect;
type Enrollee = typeof hmoEnrollees.$inferSelect;

export interface Membership {
  enrollee: Enrollee;
  plan: Plan;
  hmo: { id: string; name: string; code: string; logo: string | null };
}

const live = (from: Date | null, to: Date | null, now: Date) =>
  (!from || from <= now) && (!to || to > now);

/** The enrollee's membership if it is usable right now (enrollee, plan and HMO all active and in date). */
async function usableMembership(
  enrollee: Enrollee,
  executor: Executor = db,
): Promise<Membership | null> {
  const now = new Date();
  if (enrollee.status !== 'active' || !live(enrollee.validFrom, enrollee.validTo, now)) return null;
  const [row] = await executor
    .select({
      plan: hmoPlans,
      hmo: { id: hmos.id, name: hmos.name, code: hmos.code, logo: hmos.logo, status: hmos.status },
    })
    .from(hmoPlans)
    .innerJoin(hmos, eq(hmos.id, hmoPlans.hmoId))
    .where(eq(hmoPlans.id, enrollee.planId))
    .limit(1);
  if (
    !row ||
    row.hmo.status !== 'active' ||
    !row.plan.isActive ||
    !live(row.plan.validFrom, row.plan.validTo, now)
  )
    return null;
  const { id, name, code, logo } = row.hmo;
  return { enrollee, plan: row.plan, hmo: { id, name, code, logo } };
}

/**
 * Links an account to the one unlinked roster entry that carries its email or
 * phone number. Ambiguous matches (several entries) are left for an admin.
 */
export async function autoMatch(userId: string): Promise<Enrollee | null> {
  const [user] = await db
    .select({ email: users.email, phone: users.phoneNumber, country: users.country })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const phone = toE164(user.phone, user.country ?? 'NG');
  const keys: SQL[] = [];
  if (user.email) keys.push(eq(hmoEnrollees.email, user.email.trim().toLowerCase()));
  if (phone) keys.push(eq(hmoEnrollees.phone, phone));
  if (!keys.length) return null;
  const candidates = await db
    .select()
    .from(hmoEnrollees)
    // Never-linked entries only: someone who unlinked must not be re-linked behind their back.
    .where(
      and(
        isNull(hmoEnrollees.userId),
        isNull(hmoEnrollees.linkedAt),
        eq(hmoEnrollees.status, 'active'),
        or(...keys),
      ),
    )
    .limit(2);
  if (candidates.length !== 1) return null;
  try {
    const linked = await db
      .update(hmoEnrollees)
      .set({ userId, linkedAt: new Date(), linkMethod: 'match' })
      .where(and(eq(hmoEnrollees.id, candidates[0]!.id), isNull(hmoEnrollees.userId)));
    if (affectedRows(linked) === 0) return null; // someone else linked it first
  } catch (err) {
    if (isDuplicateKeyError(err)) return null; // account already linked elsewhere
    throw err;
  }
  logger.info({ userId, enrolleeId: candidates[0]!.id }, 'HMO enrollee auto-matched');
  return { ...candidates[0]!, userId, linkMethod: 'match' };
}

/** The account's active HMO membership, matching it to the roster first if needed. */
export async function membershipFor(
  userId: string,
  executor: Executor = db,
): Promise<Membership | null> {
  let [enrollee] = await executor
    .select()
    .from(hmoEnrollees)
    .where(eq(hmoEnrollees.userId, userId))
    .limit(1);
  if (!enrollee) enrollee = (await autoMatch(userId)) ?? undefined;
  return enrollee ? usableMembership(enrollee, executor) : null;
}

/** Package-specific rules win over the plan's "all consultations" rule. */
function pickRule(rules: Rule[], service: HmoService, packageId: string | null): Rule | null {
  const forService = rules.filter((r) => r.isActive && r.service === service);
  return (
    (packageId && forService.find((r) => r.packageId === packageId)) ||
    forService.find((r) => r.packageId === null) ||
    null
  );
}

/** Where a usage limit's window starts: this month, this year, or the start of the contract. */
export function periodStart(
  rule: Pick<Rule, 'limitPeriod'>,
  membership: Pick<Membership, 'plan' | 'enrollee'>,
  now = new Date(),
): Date {
  if (rule.limitPeriod === 'month')
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (rule.limitPeriod === 'year') return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return membership.plan.validFrom ?? membership.enrollee.validFrom ?? new Date(0);
}

/** How long an unpaid booking or order keeps its covered use reserved. */
const UNPAID_HOLD_MS = 60 * 60_000;

/**
 * Claims that count against a limit: not voided or rejected, and whose service
 * still stands — paid (or still within its payment hold) and not cancelled.
 */
function countsTowardLimit(now: Date) {
  const recent = new Date(now.getTime() - UNPAID_HOLD_MS);
  return and(
    notInArray(hmoClaims.status, ['void', 'rejected']),
    or(
      and(
        sql`${appointments.id} IS NOT NULL`,
        notInArray(appointments.status, ['cancelled', 'deleted']),
        or(eq(appointments.isPaid, true), gt(appointments.holdExpiresAt, now)),
      ),
      and(sql`${labResults.id} IS NOT NULL`, ne(labResults.status, 'awaiting_payment')),
      and(sql`${labResults.id} IS NOT NULL`, gt(labResults.createdAt, new Date(now.getTime() - 24 * 3600_000))),
      and(
        sql`${orders.id} IS NOT NULL`,
        ne(orders.status, 'cancelled'),
        or(ne(orders.status, 'awaiting_payment'), gt(orders.createdAt, recent)),
      ),
    ),
  );
}

/** Uses and HMO-paid naira under one rule since `since`. */
export async function limitUsage(
  enrolleeId: string,
  ruleId: string,
  since: Date,
  executor: Executor = db,
): Promise<{ count: number; amount: number }> {
  const [row] = await executor
    .select({ n: count(), amount: sum(hmoClaims.hmoAmount).mapWith(Number) })
    .from(hmoClaims)
    .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
    .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
    .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
    .where(
      and(
        eq(hmoClaims.enrolleeId, enrolleeId),
        eq(hmoClaims.ruleId, ruleId),
        gte(hmoClaims.serviceDate, since),
        countsTowardLimit(new Date()),
      ),
    );
  return { count: row?.n ?? 0, amount: round2(row?.amount ?? 0) };
}

export async function usageCount(
  enrolleeId: string,
  ruleId: string,
  since: Date,
  executor: Executor = db,
): Promise<number> {
  return (await limitUsage(enrolleeId, ruleId, since, executor)).count;
}

export interface CoverageDecision extends CoverageAmounts {
  membership: Membership;
  rule: Rule;
  standardAmount: number;
  summary: string;
  usage: { used: number; limit: number; period: string } | null;
  /** Medicines: the naira allowance, including what this use takes from it. */
  allowance: { used: number; limit: number; period: string } | null;
}

export interface CoverageCheck {
  decision: CoverageDecision | null;
  /** Covered member but this use isn't: why, for the app to explain. */
  notice: 'not_covered' | 'limit_reached' | null;
  membership: Membership | null;
}

/**
 * Prices one use of a service for an account. `standardAmount` is the normal
 * NGN price. Throws HMO_LIMIT_REACHED when the agreement blocks bookings past
 * its limit (only when `enforce` is set — listings just report it).
 */
export async function coverageFor(
  userId: string,
  service: HmoService,
  packageId: string | null,
  standardAmount: number,
  opts: {
    enforce?: boolean;
    membership?: Membership | null;
    executor?: Executor;
    /** Uses priced earlier in the same cart but not yet recorded. */
    pending?: { uses: number; amount: number };
  } = {},
): Promise<CoverageCheck> {
  const membership =
    opts.membership !== undefined ? opts.membership : await membershipFor(userId, opts.executor);
  if (!membership) return { decision: null, notice: null, membership: null };

  const rules = await (opts.executor ?? db)
    .select()
    .from(hmoPlanRules)
    .where(eq(hmoPlanRules.planId, membership.plan.id));
  const rule = pickRule(rules, service, packageId);
  if (!rule || rule.coverage === 'not_covered')
    return { decision: null, notice: 'not_covered', membership };

  const period = rule.limitPeriod ?? 'contract';
  const overLimit = (what: string) => {
    if (opts.enforce && rule.overLimit === 'block')
      throw unprocessable(
        'HMO_LIMIT_REACHED',
        `You have used all ${what} covered by ${membership.hmo.name} for this ${period}.`,
      );
    return { decision: null, notice: 'limit_reached' as const, membership };
  };

  let usage: CoverageDecision['usage'] = null;
  let spent = 0;
  if (rule.limitCount != null || rule.limitAmount != null) {
    const used = await limitUsage(
      membership.enrollee.id,
      rule.id,
      periodStart(rule, membership),
      opts.executor,
    );
    const uses = used.count + (opts.pending?.uses ?? 0);
    spent = round2(used.amount + (opts.pending?.amount ?? 0));
    if (rule.limitCount != null) {
      usage = { used: uses, limit: rule.limitCount, period };
      if (uses >= rule.limitCount)
        return overLimit(
          `${rule.limitCount} ${service === 'consultation' ? 'consultations' : service === 'medicines' ? 'medicine orders' : 'uses'}`,
        );
    }
    if (rule.limitAmount != null && spent >= rule.limitAmount)
      return overLimit(`your ₦${rule.limitAmount.toLocaleString('en-NG')} medicine allowance`);
  }

  // Medicines are billed for what was dispensed, never a fixed tariff.
  const pricingRule = service === 'medicines' ? { ...rule, hmoAmount: null } : rule;
  const amounts = applyRule(pricingRule, standardAmount, {
    withDoctorShare: service === 'consultation',
    feePolicy: await getFeePolicy(opts.executor),
  });
  if (!amounts) return { decision: null, notice: 'not_covered', membership };

  let allowance: CoverageDecision['allowance'] = null;
  if (rule.limitAmount != null) {
    // Past the allowance the member pays the difference.
    const left = round2(rule.limitAmount - spent);
    if (amounts.hmoAmount > left) {
      amounts.patientAmount = round2(amounts.patientAmount + amounts.hmoAmount - left);
      amounts.hmoAmount = left;
    }
    allowance = { used: round2(spent + amounts.hmoAmount), limit: rule.limitAmount, period };
  }
  return {
    decision: {
      ...amounts,
      membership,
      rule,
      standardAmount,
      summary: describeRule(rule),
      usage,
      allowance,
    },
    notice: null,
    membership,
  };
}

/** Records one covered use; the claim is billable once the service is paid and not cancelled (orders: delivered). */
export async function recordClaim(
  tx: Tx,
  input: {
    id?: string;
    userId: string;
    decision: CoverageDecision;
    description: string;
    appointmentId?: string;
    labResultId?: string;
    orderId?: string;
    serviceDate?: Date;
  },
) {
  const { decision } = input;
  const { rule, membership } = decision;
  const id = input.id ?? newId();
  // Re-check limits under a lock on the membership, so two simultaneous bookings can't both use the last covered visit.
  if (rule.limitCount != null || rule.limitAmount != null) {
    await tx
      .select({ id: hmoEnrollees.id })
      .from(hmoEnrollees)
      .where(eq(hmoEnrollees.id, membership.enrollee.id))
      .for('update');
    const used = await limitUsage(
      membership.enrollee.id,
      rule.id,
      periodStart(rule, membership),
      tx,
    );
    const overCount = rule.limitCount != null && used.count >= rule.limitCount;
    const overAmount =
      rule.limitAmount != null && used.amount + decision.hmoAmount > rule.limitAmount + 0.005;
    if (overCount || overAmount) {
      throw unprocessable(
        'HMO_LIMIT_REACHED',
        rule.service === 'medicines'
          ? `Your ${membership.hmo.name} medicine allowance just changed. Please review your cart and try again.`
          : `Your ${membership.hmo.name} limit was just reached. Please try again to book at the normal price.`,
      );
    }
  }
  await tx.insert(hmoClaims).values({
    id,
    hmoId: membership.hmo.id,
    planId: membership.plan.id,
    enrolleeId: membership.enrollee.id,
    ruleId: rule.id,
    userId: input.userId,
    service: rule.service,
    appointmentId: input.appointmentId ?? null,
    labResultId: input.labResultId ?? null,
    orderId: input.orderId ?? null,
    description: input.description.slice(0, 255),
    enrolleeCode: membership.enrollee.enrolleeCode,
    coverage: rule.coverage,
    standardAmount: decision.standardAmount,
    patientAmount: decision.patientAmount,
    hmoAmount: decision.hmoAmount,
    doctorEarning: decision.doctorEarning,
    serviceDate: input.serviceDate ?? new Date(),
  });
  return id;
}

/** For listings: what an enrollee pays per package, in one pass. */
export async function coverageForPackages(
  userId: string,
  packages: Array<{ id: string; standardAmount: number }>,
): Promise<Map<string, CoverageCheck>> {
  const result = new Map<string, CoverageCheck>();
  const membership = await membershipFor(userId);
  if (!membership) return result;
  for (const p of packages)
    result.set(
      p.id,
      await coverageFor(userId, 'consultation', p.id, p.standardAmount, { membership }),
    );
  return result;
}
