import { and, asc, count, eq, inArray, isNotNull, sql, sum } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  appointmentPackages,
  hmoClaims,
  hmoEnrollees,
  hmoPlanRules,
  hmoPlans,
  hmos,
  type HmoBilling,
  type HmoService,
} from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { getFeePolicy } from '../pricing/fees.js';
import { quoteFromUsd } from '../pricing/pricing.service.js';
import { standardLabPrice } from '../lab-results/lab-results.service.js';
import { changedFields, describeChanges, recordActivity, type Actor } from './hmo.activity.js';
import { NIGERIA, applyRule, benefitLabel, describeRule } from './hmo.pricing.js';
import type { RuleInput } from './hmo.schemas.js';
import type { z } from 'zod';
import type { hmoSchema, planSchema, updateHmoSchema, updatePlanSchema } from './hmo.schemas.js';

export async function standardConsultationPrice(amountUsd: number) {
  return (await quoteFromUsd(amountUsd, NIGERIA)).amount;
}

// ── HMOs ────────────────────────────────────────────────────────────────────

export async function listHmos() {
  const rows = await db.select().from(hmos).orderBy(asc(hmos.name));
  if (!rows.length) return [];
  const ids = rows.map((h) => h.id);
  const [enrollees, linked, unbilled] = await Promise.all([
    db
      .select({ hmoId: hmoEnrollees.hmoId, n: count() })
      .from(hmoEnrollees)
      .where(inArray(hmoEnrollees.hmoId, ids))
      .groupBy(hmoEnrollees.hmoId),
    db
      .select({ hmoId: hmoEnrollees.hmoId, n: count() })
      .from(hmoEnrollees)
      .where(and(inArray(hmoEnrollees.hmoId, ids), isNotNull(hmoEnrollees.userId)))
      .groupBy(hmoEnrollees.hmoId),
    db
      .select({
        hmoId: hmoClaims.hmoId,
        total: sum(hmoClaims.hmoAmount).mapWith(Number),
        n: count(),
      })
      .from(hmoClaims)
      .where(and(inArray(hmoClaims.hmoId, ids), eq(hmoClaims.status, 'unbilled')))
      .groupBy(hmoClaims.hmoId),
  ]);
  const by = <T extends { hmoId: string }>(list: T[]) => new Map(list.map((r) => [r.hmoId, r]));
  const [e, l, u] = [by(enrollees), by(linked), by(unbilled)];
  return rows.map((h) => ({
    ...h,
    enrollees: e.get(h.id)?.n ?? 0,
    linkedEnrollees: l.get(h.id)?.n ?? 0,
    unbilledClaims: u.get(h.id)?.n ?? 0,
    unbilledAmount: u.get(h.id)?.total ?? 0,
  }));
}

export async function requireHmo(hmoId: string) {
  const [hmo] = await db.select().from(hmos).where(eq(hmos.id, hmoId)).limit(1);
  if (!hmo) throw notFound('HMO');
  return hmo;
}

export async function getHmo(hmoId: string) {
  const hmo = await requireHmo(hmoId);
  const plans = await db
    .select()
    .from(hmoPlans)
    .where(eq(hmoPlans.hmoId, hmoId))
    .orderBy(asc(hmoPlans.createdAt));
  const rules = plans.length
    ? await db
        .select({ rule: hmoPlanRules, packageName: appointmentPackages.name })
        .from(hmoPlanRules)
        .leftJoin(appointmentPackages, eq(appointmentPackages.id, hmoPlanRules.packageId))
        .where(
          inArray(
            hmoPlanRules.planId,
            plans.map((p) => p.id),
          ),
        )
        .orderBy(asc(hmoPlanRules.service), asc(hmoPlanRules.createdAt))
    : [];
  const members = plans.length
    ? await db
        .select({ planId: hmoEnrollees.planId, n: count() })
        .from(hmoEnrollees)
        .where(eq(hmoEnrollees.hmoId, hmoId))
        .groupBy(hmoEnrollees.planId)
    : [];
  return {
    ...hmo,
    plans: plans.map((p) => ({
      ...p,
      enrollees: members.find((m) => m.planId === p.id)?.n ?? 0,
      rules: rules
        .filter((r) => r.rule.planId === p.id)
        .map((r) => ({ ...r.rule, packageName: r.packageName, summary: describeRule(r.rule) })),
    })),
  };
}

const codeTaken = () => conflict('HMO_CODE_TAKEN', 'Another HMO already uses that code');

export async function createHmo(input: z.infer<typeof hmoSchema>) {
  const id = newId();
  try {
    await db.insert(hmos).values({ id, ...input });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw codeTaken();
    throw err;
  }
  return getHmo(id);
}

/** Admin `notes` are internal and never appear in the HMO's trail. */
const HMO_FIELDS = [
  'name',
  'code',
  'logo',
  'contactName',
  'contactEmail',
  'contactPhone',
  'address',
  'status',
  'paymentTermsDays',
] as const;
const HMO_LABELS: Record<string, string> = {
  name: 'name',
  code: 'code',
  logo: 'logo',
  contactName: 'contact name',
  contactEmail: 'contact email',
  contactPhone: 'contact phone',
  address: 'address',
  status: 'partnership status',
  paymentTermsDays: 'payment terms',
};

export async function updateHmo(
  hmoId: string,
  input: z.infer<typeof updateHmoSchema>,
  actor: Actor,
) {
  const before = await requireHmo(hmoId);
  try {
    if (Object.keys(input).length) await db.update(hmos).set(input).where(eq(hmos.id, hmoId));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw codeTaken();
    throw err;
  }
  const after = await requireHmo(hmoId);
  const diff = changedFields(before, after, HMO_FIELDS);
  if (Object.keys(diff).length) {
    await recordActivity(hmoId, actor, {
      action: 'hmo.updated',
      entityType: 'hmo',
      entityId: hmoId,
      summary: `Updated HMO details: ${describeChanges(diff, HMO_LABELS)}`,
      details: { changes: diff },
    });
  }
  return getHmo(hmoId);
}

// ── Plans & rules ───────────────────────────────────────────────────────────

/** A plan of this HMO (plans are always addressed through their HMO). */
export async function requirePlan(hmoId: string, planId: string) {
  const [plan] = await db
    .select()
    .from(hmoPlans)
    .where(and(eq(hmoPlans.id, planId), eq(hmoPlans.hmoId, hmoId)))
    .limit(1);
  if (!plan) throw notFound('Plan');
  return plan;
}

const checkWindow = (from?: Date | null, to?: Date | null) => {
  if (from && to && to <= from)
    throw badRequest('The plan must end after it starts', [
      { path: 'validTo', message: 'before start' },
    ]);
};

export async function createPlan(hmoId: string, input: z.infer<typeof planSchema>, actor: Actor) {
  await requireHmo(hmoId);
  checkWindow(input.validFrom, input.validTo);
  const id = newId();
  await db.insert(hmoPlans).values({
    id,
    hmoId,
    ...input,
    capitationRate: input.paymentModel === 'capitation' ? (input.capitationRate ?? null) : null,
  });
  await recordActivity(hmoId, actor, {
    action: 'plan.created',
    entityType: 'plan',
    entityId: id,
    summary: `Created plan ${input.name}${input.paymentModel === 'capitation' ? ` (capitation ${ngn(input.capitationRate)} per member per month)` : ''}`,
  });
  return getHmo(hmoId);
}

const PLAN_LABELS = {
  name: 'name',
  isActive: 'active',
  validFrom: 'start date',
  validTo: 'end date',
  paymentModel: 'payment model',
  capitationRate: 'capitation rate',
  notes: 'notes',
};

const ngn = (n: number | null | undefined) => `₦${Number(n ?? 0).toLocaleString('en-NG')}`;

export async function updatePlan(
  hmoId: string,
  planId: string,
  input: z.infer<typeof updatePlanSchema>,
  actor: Actor,
) {
  const plan = await requirePlan(hmoId, planId);
  checkWindow(input.validFrom ?? plan.validFrom, input.validTo ?? plan.validTo);
  const model = input.paymentModel ?? plan.paymentModel;
  const changes = { ...input };
  if (model === 'capitation') {
    if ((input.capitationRate ?? plan.capitationRate) == null)
      throw badRequest('Enter the capitation rate per member per month', [
        { path: 'capitationRate', message: 'required' },
      ]);
  } else {
    changes.capitationRate = null;
    if (plan.paymentModel === 'capitation') {
      const [capitated] = await db
        .select({ n: count() })
        .from(hmoPlanRules)
        .where(
          and(
            eq(hmoPlanRules.planId, planId),
            eq(hmoPlanRules.billing, 'capitation'),
            eq(hmoPlanRules.isActive, true),
          ),
        );
      if ((capitated?.n ?? 0) > 0)
        throw conflict(
          'HMO_PLAN_HAS_CAPITATED_BENEFITS',
          'Switch this plan’s capitated benefits to per-use billing first.',
        );
    }
  }
  if (Object.keys(changes).length)
    await db.update(hmoPlans).set(changes).where(eq(hmoPlans.id, planId));
  const diff = changedFields(plan, await requirePlan(hmoId, planId), [
    'name',
    'isActive',
    'validFrom',
    'validTo',
    'paymentModel',
    'capitationRate',
    'notes',
  ]);
  if (Object.keys(diff).length) {
    await recordActivity(hmoId, actor, {
      action: 'plan.updated',
      entityType: 'plan',
      entityId: planId,
      summary: `Updated plan ${plan.name}: ${describeChanges(diff, PLAN_LABELS)}`,
      details: { changes: diff },
    });
  }
  return getHmo(hmoId);
}

async function checkRuleTarget(planId: string, rule: RuleInput, ignoreRuleId?: string) {
  if (rule.packageId) {
    const [pkg] = await db
      .select({ id: appointmentPackages.id })
      .from(appointmentPackages)
      .where(eq(appointmentPackages.id, rule.packageId));
    if (!pkg)
      throw badRequest('Unknown consultation package', [
        { path: 'packageId', message: 'not found' },
      ]);
  }
  // One active rule per service + package in a plan, so pricing is never ambiguous.
  const clash = await db
    .select({ id: hmoPlanRules.id })
    .from(hmoPlanRules)
    .where(
      and(
        eq(hmoPlanRules.planId, planId),
        eq(hmoPlanRules.service, rule.service),
        eq(hmoPlanRules.isActive, true),
        rule.packageId
          ? eq(hmoPlanRules.packageId, rule.packageId)
          : sql`${hmoPlanRules.packageId} IS NULL`,
      ),
    );
  if (rule.isActive && clash.some((c) => c.id !== ignoreRuleId)) {
    throw conflict(
      'HMO_RULE_EXISTS',
      'This plan already has an active rule for that service and package. Edit it instead.',
    );
  }
}

const ruleValues = (rule: RuleInput) => ({
  service: rule.service,
  packageId: rule.service === 'consultation' ? (rule.packageId ?? null) : null,
  coverage: rule.coverage,
  patientAmount: rule.patientAmount ?? null,
  percent: rule.percent ?? null,
  hmoAmount: rule.hmoAmount ?? null,
  doctorEarning: rule.doctorEarning ?? null,
  limitCount: rule.limitCount ?? null,
  limitAmount: rule.limitAmount ?? null,
  authorizationAbove: rule.authorizationAbove ?? null,
  limitPeriod: rule.limitCount || rule.limitAmount ? (rule.limitPeriod ?? null) : null,
  overLimit: rule.overLimit,
  billing: rule.billing,
  isActive: rule.isActive,
});

/** Capitated benefits only make sense on a plan the HMO pays capitation for. */
function checkBilling(plan: { paymentModel: string; name: string }, rule: RuleInput) {
  if (rule.billing === 'capitation' && plan.paymentModel !== 'capitation')
    throw badRequest(`${plan.name} isn’t a capitation plan. Set its payment model to capitation first.`, [
      { path: 'billing', message: 'plan is fee-for-service' },
    ]);
}

/** "GP consultation — You pay ₦1,000 (HMO tariff ₦6,000, 4 per month)". */
async function describeBenefit(rule: Omit<RuleInput, 'overLimit' | 'isActive' | 'billing'> & { billing?: HmoBilling }) {
  const [pkg] = rule.packageId
    ? await db
        .select({ name: appointmentPackages.name })
        .from(appointmentPackages)
        .where(eq(appointmentPackages.id, rule.packageId))
    : [];
  const terms = [
    rule.billing === 'capitation' ? 'paid by capitation' : null,
    rule.hmoAmount != null ? `HMO tariff ₦${Number(rule.hmoAmount).toLocaleString('en-NG')}` : null,
    rule.limitCount ? `${rule.limitCount} per ${rule.limitPeriod}` : null,
    rule.limitAmount != null
      ? `₦${Number(rule.limitAmount).toLocaleString('en-NG')} per ${rule.limitPeriod}`
      : null,
    rule.authorizationAbove != null
      ? rule.authorizationAbove === 0
        ? 'needs HMO approval'
        : `needs HMO approval above ₦${Number(rule.authorizationAbove).toLocaleString('en-NG')}`
      : null,
  ].filter(Boolean);
  const label = benefitLabel(rule.service, pkg?.name ?? null);
  return `${label} — ${describeRule({ ...rule, patientAmount: rule.patientAmount ?? null, percent: rule.percent ?? null, hmoAmount: rule.hmoAmount ?? null, doctorEarning: null })}${terms.length ? ` (${terms.join(', ')})` : ''}`;
}

export async function createRule(hmoId: string, planId: string, rule: RuleInput, actor: Actor) {
  const plan = await requirePlan(hmoId, planId);
  checkBilling(plan, rule);
  await checkRuleTarget(planId, rule);
  const id = newId();
  await db.insert(hmoPlanRules).values({ id, planId, ...ruleValues(rule) });
  await recordActivity(hmoId, actor, {
    action: 'benefit.created',
    entityType: 'plan',
    entityId: planId,
    summary: `Added to ${plan.name}: ${await describeBenefit(rule)}${rule.isActive ? '' : ' (inactive)'}`,
  });
  return getHmo(hmoId);
}

/** Rules are replaced whole: each edit is re-validated as a complete agreement line. */
export async function updateRule(
  hmoId: string,
  planId: string,
  ruleId: string,
  rule: RuleInput,
  actor: Actor,
) {
  const plan = await requirePlan(hmoId, planId);
  const [existing] = await db
    .select()
    .from(hmoPlanRules)
    .where(and(eq(hmoPlanRules.id, ruleId), eq(hmoPlanRules.planId, planId)));
  if (!existing) throw notFound('Rule');
  checkBilling(plan, rule);
  await checkRuleTarget(planId, rule, ruleId);
  await db.update(hmoPlanRules).set(ruleValues(rule)).where(eq(hmoPlanRules.id, ruleId));
  const [was, now] = [await describeBenefit(existing), await describeBenefit(rule)];
  const switched = existing.isActive !== rule.isActive;
  if (was !== now || switched) {
    await recordActivity(hmoId, actor, {
      action: 'benefit.updated',
      entityType: 'plan',
      entityId: planId,
      summary:
        was === now
          ? `${rule.isActive ? 'Switched on' : 'Switched off'} in ${plan.name}: ${now}`
          : `Changed in ${plan.name}: ${was} → ${now}${rule.isActive ? '' : ' (inactive)'}`,
    });
  }
  return getHmo(hmoId);
}

/** Rules already used by claims are switched off instead, so past claims keep their link. */
export async function deleteRule(hmoId: string, planId: string, ruleId: string, actor: Actor) {
  const plan = await requirePlan(hmoId, planId);
  const [rule] = await db
    .select()
    .from(hmoPlanRules)
    .where(and(eq(hmoPlanRules.id, ruleId), eq(hmoPlanRules.planId, planId)));
  if (!rule) return getHmo(hmoId);
  const [used] = await db
    .select({ n: count() })
    .from(hmoClaims)
    .where(eq(hmoClaims.ruleId, ruleId));
  if ((used?.n ?? 0) > 0)
    await db
      .update(hmoPlanRules)
      .set({ isActive: false })
      .where(and(eq(hmoPlanRules.id, ruleId), eq(hmoPlanRules.planId, planId)));
  else
    await db
      .delete(hmoPlanRules)
      .where(and(eq(hmoPlanRules.id, ruleId), eq(hmoPlanRules.planId, planId)));
  await recordActivity(hmoId, actor, {
    action: 'benefit.removed',
    entityType: 'plan',
    entityId: planId,
    summary: `Removed from ${plan.name}: ${await describeBenefit(rule)}`,
  });
  return getHmo(hmoId);
}

/**
 * What every service costs under a plan right now: the admin's check that the
 * agreement matches the contract before members use it.
 */
const MEDICINE_EXAMPLE = 10_000;

export async function pricePreview(hmoId: string, planId: string) {
  await requirePlan(hmoId, planId);
  const [rules, packages, labStandard, feePolicy] = await Promise.all([
    db
      .select()
      .from(hmoPlanRules)
      .where(and(eq(hmoPlanRules.planId, planId), eq(hmoPlanRules.isActive, true))),
    db
      .select()
      .from(appointmentPackages)
      .where(eq(appointmentPackages.isActive, true))
      .orderBy(appointmentPackages.sortOrder),
    standardLabPrice(),
    getFeePolicy(),
  ]);
  const pick = (service: HmoService, packageId: string | null) =>
    rules.find((r) => r.service === service && r.packageId === packageId) ??
    rules.find((r) => r.service === service && r.packageId === null) ??
    null;
  const line = (
    label: string,
    standard: number,
    rule: (typeof rules)[number] | null,
    withDoctorShare: boolean,
  ) => {
    const amounts = rule ? applyRule(rule, standard, { withDoctorShare, feePolicy }) : null;
    return {
      label,
      standardAmount: standard,
      covered: Boolean(amounts),
      summary: rule
        ? `${describeRule(rule)}${rule.billing === 'capitation' ? ' · paid by capitation' : ''}`
        : 'No rule — normal price',
      patientAmount: amounts?.patientAmount ?? standard,
      hmoAmount: amounts?.hmoAmount ?? 0,
      doctorEarning: withDoctorShare ? (amounts?.doctorEarning ?? null) : null,
      limit:
        [
          rule?.limitCount ? `${rule.limitCount} per ${rule.limitPeriod}` : null,
          rule?.limitAmount
            ? `₦${Number(rule.limitAmount).toLocaleString('en-NG')} per ${rule.limitPeriod}`
            : null,
          rule?.authorizationAbove != null
            ? rule.authorizationAbove === 0
              ? 'needs HMO approval'
              : `needs approval above ₦${Number(rule.authorizationAbove).toLocaleString('en-NG')}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    };
  };
  const consultations = await Promise.all(
    packages.map(async (p) => ({
      packageId: p.id,
      ...line(
        p.name,
        await standardConsultationPrice(p.amountUsd),
        pick('consultation', p.id),
        true,
      ),
    })),
  );
  return {
    currency: 'NGN',
    consultations,
    labInterpretation:
      labStandard === null
        ? null
        : line('Lab result interpretation', labStandard, pick('lab_interpretation', null), false),
    // Medicines are priced per order; show the agreement on an example basket.
    medicines: line(
      `Prescribed medicines (example ${'₦'}${MEDICINE_EXAMPLE.toLocaleString('en-NG')} order)`,
      MEDICINE_EXAMPLE,
      pick('medicines', null),
      false,
    ),
  };
}
