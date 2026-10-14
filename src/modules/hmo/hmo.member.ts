import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointmentPackages,
  hmoEnrollees,
  hmoLinkRequests,
  hmoPlanRules,
  hmos,
  users,
} from '../../db/schema/index.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toE164 } from '../../lib/phone.js';
import { limitUsage, membershipFor } from './hmo.coverage.js';
import { normalisePhone } from './hmo.enrollees.js';
import { describeRule } from './hmo.pricing.js';
import type { linkSchema } from './hmo.schemas.js';

/** The patient's side: partner HMOs, "Link my HMO", and what their membership covers. */

export async function listPartners() {
  return db
    .select({ id: hmos.id, name: hmos.name, code: hmos.code, logo: hmos.logo })
    .from(hmos)
    .where(eq(hmos.status, 'active'))
    .orderBy(asc(hmos.name));
}

export async function myCoverage(userId: string) {
  const membership = await membershipFor(userId);
  const [pending] = await db
    .select({
      id: hmoLinkRequests.id,
      hmoName: hmos.name,
      enrolleeCode: hmoLinkRequests.enrolleeCode,
      createdAt: hmoLinkRequests.createdAt,
    })
    .from(hmoLinkRequests)
    .innerJoin(hmos, eq(hmos.id, hmoLinkRequests.hmoId))
    .where(and(eq(hmoLinkRequests.userId, userId), eq(hmoLinkRequests.status, 'pending')))
    .orderBy(desc(hmoLinkRequests.createdAt))
    .limit(1);
  // A linked membership that has lapsed is still shown, so the app can say why prices are normal again.
  const [linked] = membership
    ? []
    : await db
        .select({ status: hmoEnrollees.status, validTo: hmoEnrollees.validTo, hmoName: hmos.name })
        .from(hmoEnrollees)
        .innerJoin(hmos, eq(hmos.id, hmoEnrollees.hmoId))
        .where(eq(hmoEnrollees.userId, userId))
        .limit(1);

  if (!membership) {
    return {
      membership: null,
      inactive: linked
        ? {
            hmoName: linked.hmoName,
            reason: linked.status !== 'active' ? linked.status : 'expired_or_paused',
          }
        : null,
      pendingRequest: pending ?? null,
    };
  }
  const rules = await db
    .select({ rule: hmoPlanRules, packageName: appointmentPackages.name })
    .from(hmoPlanRules)
    .leftJoin(appointmentPackages, eq(appointmentPackages.id, hmoPlanRules.packageId))
    .where(
      and(
        eq(hmoPlanRules.planId, membership.plan.id),
        eq(hmoPlanRules.isActive, true),
        ne(hmoPlanRules.coverage, 'not_covered'),
      ),
    )
    .orderBy(asc(hmoPlanRules.service));
  const now = new Date();
  const since = (period: string | null) =>
    period === 'month'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : period === 'year'
        ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
        : (membership.plan.validFrom ?? membership.enrollee.validFrom ?? new Date(0));
  const benefits = await Promise.all(
    rules.map(async ({ rule, packageName }) => {
      const used =
        rule.limitCount || rule.limitAmount
          ? await limitUsage(membership.enrollee.id, rule.id, since(rule.limitPeriod))
          : null;
      return {
        service: rule.service,
        label:
          rule.service === 'lab_interpretation'
            ? 'Lab result interpretation'
            : rule.service === 'medicines'
              ? 'Prescribed medicines'
              : packageName
                ? `${packageName} consultation`
                : 'Consultations',
        summary:
          rule.service === 'medicines'
            ? `${describeRule(rule)} · prescribed by an Instant Doctor doctor · delivery not included`
            : describeRule(rule),
        limit:
          rule.limitCount && used
            ? { count: rule.limitCount, period: rule.limitPeriod, used: used.count }
            : null,
        allowance:
          rule.limitAmount != null && used
            ? { limit: rule.limitAmount, used: used.amount, period: rule.limitPeriod }
            : null,
        /** The HMO must approve uses costing it more than this (0 = every use). */
        approvalAbove: rule.authorizationAbove,
      };
    }),
  );
  return {
    membership: {
      hmo: membership.hmo,
      plan: { id: membership.plan.id, name: membership.plan.name },
      enrolleeCode: membership.enrollee.enrolleeCode,
      validTo: membership.enrollee.validTo ?? membership.plan.validTo,
      benefits,
    },
    inactive: null,
    pendingRequest: null,
  };
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Self-service linking. The enrollee code must be on the HMO's list and at
 * least one detail the patient gives must match that record; otherwise the
 * attempt is queued for an admin. A code already linked to someone else is
 * never handed over automatically.
 */
export async function linkMembership(userId: string, input: z.infer<typeof linkSchema>) {
  const [hmo] = await db
    .select({ id: hmos.id, name: hmos.name, status: hmos.status })
    .from(hmos)
    .where(eq(hmos.id, input.hmoId))
    .limit(1);
  if (!hmo || hmo.status !== 'active') throw notFound('HMO');
  const code = input.enrolleeCode.trim().toUpperCase();
  const [enrollee] = await db
    .select()
    .from(hmoEnrollees)
    .where(and(eq(hmoEnrollees.hmoId, hmo.id), eq(hmoEnrollees.enrolleeCode, code)))
    .limit(1);
  const [user] = await db
    .select({ country: users.country })
    .from(users)
    .where(eq(users.id, userId));

  const details = Object.fromEntries(
    Object.entries({
      lastName: input.lastName,
      phone: input.phone,
      dateOfBirth: input.dateOfBirth,
    }).filter(([, v]) => v),
  ) as Record<string, string>;
  const queue = async (reason: 'no_match' | 'already_linked') => {
    await db
      .update(hmoLinkRequests)
      .set({ status: 'rejected', reviewNote: 'Superseded by a newer request' })
      .where(and(eq(hmoLinkRequests.userId, userId), eq(hmoLinkRequests.status, 'pending')));
    await db
      .insert(hmoLinkRequests)
      .values({ id: newId(), userId, hmoId: hmo.id, enrolleeCode: code, reason, details });
  };

  if (enrollee?.userId === userId)
    return { status: 'linked' as const, coverage: await myCoverage(userId) };

  const phone = toE164(input.phone, user?.country ?? 'NG') ?? normalisePhone(input.phone);
  const verified =
    enrollee &&
    enrollee.status === 'active' &&
    (sameText(input.lastName, enrollee.lastName) ||
      Boolean(phone && phone === enrollee.phone) ||
      Boolean(input.dateOfBirth && input.dateOfBirth === enrollee.dateOfBirth));

  if (enrollee && verified && enrollee.userId) {
    await queue('already_linked');
    throw conflict(
      'ENROLLEE_ALREADY_LINKED',
      'This membership is already linked to another account. We have asked our team to review it.',
    );
  }
  if (!enrollee || !verified) {
    await queue('no_match');
    return { status: 'pending_review' as const, coverage: await myCoverage(userId) };
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(hmoEnrollees)
        .set({ userId: null, linkMethod: null })
        .where(eq(hmoEnrollees.userId, userId));
      const linked = await tx
        .update(hmoEnrollees)
        .set({ userId, linkedAt: new Date(), linkMethod: 'self' })
        .where(and(eq(hmoEnrollees.id, enrollee.id), isNull(hmoEnrollees.userId)));
      if (affectedRows(linked) === 0)
        throw conflict(
          'ENROLLEE_ALREADY_LINKED',
          'This membership was just linked to another account.',
        );
      await tx
        .update(hmoLinkRequests)
        .set({ status: 'rejected', reviewNote: 'Linked automatically' })
        .where(and(eq(hmoLinkRequests.userId, userId), eq(hmoLinkRequests.status, 'pending')));
    });
  } catch (err) {
    if (isDuplicateKeyError(err))
      throw conflict(
        'ACCOUNT_ALREADY_LINKED',
        'Your account is already linked to an HMO membership.',
      );
    throw err;
  }
  return { status: 'linked' as const, coverage: await myCoverage(userId) };
}

/** linkedAt is kept so automatic matching never quietly re-links someone who chose to unlink. */
export async function unlinkMembership(userId: string) {
  await db
    .update(hmoEnrollees)
    .set({ userId: null, linkMethod: null })
    .where(eq(hmoEnrollees.userId, userId));
  return { unlinked: true };
}
