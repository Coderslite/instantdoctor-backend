import { and, asc, count, eq, gt, gte, inArray, isNull, lte, or, sql, sum } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  appointments,
  hmoCapitationLines,
  hmoClaims,
  hmoEnrollees,
  hmoInvoices,
  hmoPlans,
  labResults,
  orders,
} from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { requirePlan } from './hmo.agreements.js';
import { serviceStands } from './hmo.claims.js';

/**
 * Capitation: on a capitation plan the HMO pays a fixed amount per enrollee
 * per month, for every member on its list who is active on the 1st —
 * whether or not they have linked the app or used a service that month.
 * Uses of capitated benefits are recorded as ₦0 encounters for utilisation.
 * Months are calendar months in Lagos (WAT, UTC+1).
 */

/** "2026-10" → 1 October 2026, 00:00 in Lagos. */
export const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000+01:00`);

/** The Lagos month a moment falls in, as YYYY-MM. */
export function monthOf(at: Date) {
  const lagos = new Date(at.getTime() + 3600_000);
  return `${lagos.getUTCFullYear()}-${String(lagos.getUTCMonth() + 1).padStart(2, '0')}`;
}

const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** Months whose 1st falls in [from, to). */
export function monthsBetween(from: Date, to: Date) {
  const out: string[] = [];
  let month = monthOf(from);
  if (monthStart(month) < from) month = nextMonth(month);
  while (monthStart(month) < to) {
    out.push(month);
    month = nextMonth(month);
  }
  return out;
}

/** Members of a plan who were active at the start of the month. */
const activeOnFirst = (planId: string, start: Date) =>
  and(
    eq(hmoEnrollees.planId, planId),
    lte(sql`COALESCE(${hmoEnrollees.validFrom}, ${hmoEnrollees.createdAt})`, start),
    or(isNull(hmoEnrollees.validTo), gt(hmoEnrollees.validTo, start)),
    or(eq(hmoEnrollees.status, 'active'), gt(hmoEnrollees.deactivatedAt, start)),
  );

export async function membersOnFirst(planId: string, month: string, executor: Executor = db) {
  const [row] = await executor
    .select({ n: count() })
    .from(hmoEnrollees)
    .where(activeOnFirst(planId, monthStart(month)));
  return row?.n ?? 0;
}

/** Who was counted for a plan and month, so the HMO can reconcile against its own list. */
export async function capitationMembers(hmoId: string, planId: string, month: string) {
  await requirePlan(hmoId, planId);
  return db
    .select({
      enrolleeCode: hmoEnrollees.enrolleeCode,
      firstName: hmoEnrollees.firstName,
      lastName: hmoEnrollees.lastName,
      status: hmoEnrollees.status,
      linked: sql<boolean>`${hmoEnrollees.userId} IS NOT NULL`,
    })
    .from(hmoEnrollees)
    .where(activeOnFirst(planId, monthStart(month)))
    .orderBy(asc(hmoEnrollees.enrolleeCode));
}

type Plan = typeof hmoPlans.$inferSelect;

/** The plan's contract covers the 1st of the month. */
const planCovers = (plan: Plan, start: Date) =>
  (!plan.validFrom || plan.validFrom <= start) && (!plan.validTo || plan.validTo > start);

/**
 * Capitation not yet billed for months starting in [from, to): one line per
 * capitation plan and month in its contract, members × rate.
 */
export async function capitationDue(hmoId: string, from: Date, to: Date, executor: Executor = db) {
  const plans = await executor
    .select()
    .from(hmoPlans)
    .where(and(eq(hmoPlans.hmoId, hmoId), eq(hmoPlans.paymentModel, 'capitation'), eq(hmoPlans.isActive, true)));
  const months = monthsBetween(from, to);
  if (!plans.length || !months.length) return [];
  const billed = await executor
    .select({ planId: hmoCapitationLines.planId, month: hmoCapitationLines.month })
    .from(hmoCapitationLines)
    .where(inArray(hmoCapitationLines.planId, plans.map((p) => p.id)));
  const done = new Set(billed.map((b) => `${b.planId}:${b.month}`));
  const lines = [];
  for (const plan of plans) {
    if (!plan.capitationRate) continue;
    for (const month of months) {
      if (done.has(`${plan.id}:${month}`) || !planCovers(plan, monthStart(month))) continue;
      const members = await membersOnFirst(plan.id, month, executor);
      if (!members) continue;
      lines.push({
        planId: plan.id,
        planName: plan.name,
        month,
        members,
        rate: plan.capitationRate,
        amount: round2(members * plan.capitationRate),
      });
    }
  }
  return lines;
}

/**
 * Month by month for each capitation plan: what the HMO pays (billed, or due
 * if not yet invoiced) against what members used — the encounters, their
 * value at normal prices and what doctors were paid for them.
 */
export async function utilisation(hmoId: string, monthsBack = 12) {
  const plans = await db
    .select()
    .from(hmoPlans)
    .where(and(eq(hmoPlans.hmoId, hmoId), eq(hmoPlans.paymentModel, 'capitation')))
    .orderBy(asc(hmoPlans.createdAt));
  if (!plans.length) return { items: [] };
  const now = monthOf(new Date());
  let first = now;
  for (let i = 1; i < monthsBack; i++) {
    const [y, m] = first.split('-').map(Number) as [number, number];
    first = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  }
  const months = monthsBetween(monthStart(first), monthStart(nextMonth(now)));
  const planIds = plans.map((p) => p.id);
  const [lines, encounters] = await Promise.all([
    db
      .select({ line: hmoCapitationLines, reference: hmoInvoices.reference, invoiceStatus: hmoInvoices.status })
      .from(hmoCapitationLines)
      .innerJoin(hmoInvoices, eq(hmoInvoices.id, hmoCapitationLines.invoiceId))
      .where(inArray(hmoCapitationLines.planId, planIds)),
    db
      .select({
        planId: hmoClaims.planId,
        month: sql<string>`DATE_FORMAT(CONVERT_TZ(${hmoClaims.serviceDate}, '+00:00', '+01:00'), '%Y-%m')`,
        n: count(),
        value: sum(hmoClaims.standardAmount).mapWith(Number),
        cost: sum(hmoClaims.doctorEarning).mapWith(Number),
        paidByMembers: sum(hmoClaims.patientAmount).mapWith(Number),
      })
      .from(hmoClaims)
      .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
      .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
      .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
      .where(
        and(
          inArray(hmoClaims.planId, planIds),
          eq(hmoClaims.billing, 'capitation'),
          sql`${hmoClaims.status} NOT IN ('void', 'rejected')`,
          gte(hmoClaims.serviceDate, monthStart(first)),
          serviceStands(),
        ),
      )
      .groupBy(sql`1`, sql`2`),
  ]);
  const items = [];
  for (const plan of plans) {
    for (const month of months) {
      const start = monthStart(month);
      if (!planCovers(plan, start) && !lines.some((l) => l.line.planId === plan.id && l.line.month === month)) continue;
      const line = lines.find((l) => l.line.planId === plan.id && l.line.month === month);
      const used = encounters.find((e) => e.planId === plan.id && e.month === month);
      const members = line?.line.members ?? (start <= new Date() ? await membersOnFirst(plan.id, month) : 0);
      const income = line ? line.line.amount : round2(members * (plan.capitationRate ?? 0));
      const cost = round2(used?.cost ?? 0);
      items.push({
        planId: plan.id,
        planName: plan.name,
        month,
        members,
        rate: line?.line.rate ?? plan.capitationRate,
        capitation: income,
        billed: line ? { invoiceId: line.line.invoiceId, reference: line.reference, status: line.invoiceStatus } : null,
        encounters: used?.n ?? 0,
        encounterValue: round2(used?.value ?? 0),
        paidByMembers: round2(used?.paidByMembers ?? 0),
        doctorCost: cost,
        margin: round2(income - cost),
        /** Doctor cost as a share of capitation; above 100% the month lost money. */
        costRatio: income > 0 ? Math.round((cost / income) * 1000) / 10 : null,
      });
    }
  }
  return { items: items.reverse() };
}

export async function requireCapitationPlan(hmoId: string, planId: string) {
  const plan = await requirePlan(hmoId, planId);
  if (plan.paymentModel !== 'capitation') throw notFound('Capitation plan');
  return plan;
}
