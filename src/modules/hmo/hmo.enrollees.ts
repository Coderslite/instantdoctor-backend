import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  notInArray,
  or,
  sum,
} from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointmentPackages,
  hmoClaims,
  hmoEnrollees,
  hmoLinkRequests,
  hmoPlanRules,
  hmos,
  users,
} from '../../db/schema/index.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toE164 } from '../../lib/phone.js';
import { changedFields, describeChanges, recordActivity, type Actor } from './hmo.activity.js';
import { requireHmo, requirePlan } from './hmo.agreements.js';
import { limitUsage, periodStart } from './hmo.coverage.js';
import { benefitLabel, describeRule } from './hmo.pricing.js';
import type {
  enrolleeSchema,
  enrolleesQuery,
  importSchema,
  linkRequestsQuery,
  updateEnrolleeSchema,
} from './hmo.schemas.js';

/**
 * An HMO's member roster. Every function is scoped to one HMO, so the same
 * service backs the admin today and an HMO's own portal later.
 */

type Enrollee = typeof hmoEnrollees.$inferSelect;

export const normalisePhone = (raw: string | null | undefined) =>
  toE164(raw, 'NG') ?? (raw?.trim() || null);
const normaliseEmail = (raw: string | null | undefined) => raw?.trim().toLowerCase() || null;
const normaliseCode = (raw: string) => raw.trim().toUpperCase();

/** Accepts 1990-04-23, 23/04/1990 or 23-04-1990 (day first, as Nigerian records are written). */
export function parseDate(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}

const enrolleeColumns = {
  id: hmoEnrollees.id,
  hmoId: hmoEnrollees.hmoId,
  planId: hmoEnrollees.planId,
  enrolleeCode: hmoEnrollees.enrolleeCode,
  firstName: hmoEnrollees.firstName,
  lastName: hmoEnrollees.lastName,
  phone: hmoEnrollees.phone,
  email: hmoEnrollees.email,
  dateOfBirth: hmoEnrollees.dateOfBirth,
  status: hmoEnrollees.status,
  validFrom: hmoEnrollees.validFrom,
  validTo: hmoEnrollees.validTo,
  userId: hmoEnrollees.userId,
  linkedAt: hmoEnrollees.linkedAt,
  linkMethod: hmoEnrollees.linkMethod,
  createdAt: hmoEnrollees.createdAt,
  userName: users.firstName,
  userLastName: users.lastName,
  userEmail: users.email,
};

export async function listEnrollees(hmoId: string, query: z.infer<typeof enrolleesQuery>) {
  await requireHmo(hmoId);
  const term = query.search ? `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = and(
    eq(hmoEnrollees.hmoId, hmoId),
    query.status ? eq(hmoEnrollees.status, query.status) : undefined,
    query.planId ? eq(hmoEnrollees.planId, query.planId) : undefined,
    query.expiringWithinDays
      ? and(
          eq(hmoEnrollees.status, 'active'),
          gt(hmoEnrollees.validTo, new Date()),
          lt(hmoEnrollees.validTo, new Date(Date.now() + query.expiringWithinDays * 86_400_000)),
        )
      : undefined,
    query.linked === 'yes'
      ? isNotNull(hmoEnrollees.userId)
      : query.linked === 'no'
        ? isNull(hmoEnrollees.userId)
        : undefined,
    term
      ? or(
          like(hmoEnrollees.enrolleeCode, term),
          like(hmoEnrollees.firstName, term),
          like(hmoEnrollees.lastName, term),
          like(hmoEnrollees.email, term),
          like(hmoEnrollees.phone, term),
        )
      : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select(enrolleeColumns)
      .from(hmoEnrollees)
      .leftJoin(users, eq(users.id, hmoEnrollees.userId))
      .where(where)
      .orderBy(asc(hmoEnrollees.lastName), asc(hmoEnrollees.firstName))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(hmoEnrollees).where(where),
  ]);
  return {
    items: rows.map(({ userName, userLastName, userEmail, ...e }) => ({
      ...e,
      account: e.userId
        ? { id: e.userId, name: `${userName ?? ''} ${userLastName ?? ''}`.trim(), email: userEmail }
        : null,
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function requireEnrollee(hmoId: string, enrolleeId: string) {
  const [row] = await db
    .select()
    .from(hmoEnrollees)
    .where(and(eq(hmoEnrollees.id, enrolleeId), eq(hmoEnrollees.hmoId, hmoId)))
    .limit(1);
  if (!row) throw notFound('Enrollee');
  return row;
}

/**
 * One member in full: the record, each benefit of their plan with what has
 * been used of its limit in the current window, and their claim totals.
 */
export async function enrolleeProfile(hmoId: string, enrolleeId: string) {
  const enrollee = await requireEnrollee(hmoId, enrolleeId);
  const plan = await requirePlan(hmoId, enrollee.planId);
  const [rules, totals] = await Promise.all([
    db
      .select({ rule: hmoPlanRules, packageName: appointmentPackages.name })
      .from(hmoPlanRules)
      .leftJoin(appointmentPackages, eq(appointmentPackages.id, hmoPlanRules.packageId))
      .where(and(eq(hmoPlanRules.planId, plan.id), eq(hmoPlanRules.isActive, true)))
      .orderBy(asc(hmoPlanRules.service), asc(hmoPlanRules.createdAt)),
    db
      .select({
        status: hmoClaims.status,
        n: count(),
        hmoAmount: sum(hmoClaims.hmoAmount).mapWith(Number),
        patientAmount: sum(hmoClaims.patientAmount).mapWith(Number),
      })
      .from(hmoClaims)
      .where(and(eq(hmoClaims.hmoId, hmoId), eq(hmoClaims.enrolleeId, enrolleeId)))
      .groupBy(hmoClaims.status),
  ]);
  const benefits = await Promise.all(
    rules.map(async ({ rule, packageName }) => {
      const limited = rule.limitCount != null || rule.limitAmount != null;
      const used = limited
        ? await limitUsage(enrollee.id, rule.id, periodStart(rule, { plan, enrollee }))
        : null;
      return {
        ruleId: rule.id,
        service: rule.service,
        label: benefitLabel(rule.service, packageName),
        coverage: rule.coverage,
        summary: describeRule(rule),
        limitPeriod: rule.limitPeriod,
        limitCount: rule.limitCount,
        limitAmount: rule.limitAmount,
        usedCount: used?.count ?? null,
        usedAmount: used?.amount ?? null,
      };
    }),
  );
  return {
    enrollee,
    plan: {
      id: plan.id,
      name: plan.name,
      isActive: plan.isActive,
      validFrom: plan.validFrom,
      validTo: plan.validTo,
    },
    benefits,
    claimTotals: Object.fromEntries(
      totals.map((t) => [
        t.status,
        { claims: t.n, hmoAmount: t.hmoAmount ?? 0, patientAmount: t.patientAmount ?? 0 },
      ]),
    ),
  };
}

const codeTaken = (code: string) =>
  conflict('ENROLLEE_CODE_TAKEN', `Enrollee ${code} is already on this HMO's list`);
const accountTaken = () =>
  conflict(
    'ACCOUNT_ALREADY_LINKED',
    'That account is already linked to an HMO membership. Unlink it first.',
  );

const MEMBER_FIELDS = [
  'planId',
  'firstName',
  'lastName',
  'phone',
  'email',
  'dateOfBirth',
  'status',
  'validFrom',
  'validTo',
] as const;
const MEMBER_LABELS: Record<string, string> = {
  planId: 'plan',
  firstName: 'first name',
  lastName: 'surname',
  phone: 'phone',
  email: 'email',
  dateOfBirth: 'date of birth',
  status: 'status',
  validFrom: 'cover start',
  validTo: 'cover end',
  linked: 'app account',
};
const fullName = (e: Pick<Enrollee, 'firstName' | 'lastName'>) =>
  [e.firstName, e.lastName].filter(Boolean).join(' ');

export async function createEnrollee(
  hmoId: string,
  input: z.infer<typeof enrolleeSchema>,
  actor: Actor,
) {
  const plan = await requirePlan(hmoId, input.planId);
  const id = newId();
  const code = normaliseCode(input.enrolleeCode);
  try {
    await db.insert(hmoEnrollees).values({
      id,
      hmoId,
      ...input,
      enrolleeCode: code,
      phone: normalisePhone(input.phone),
      email: normaliseEmail(input.email),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw codeTaken(code);
    throw err;
  }
  await matchAccounts(hmoId, [id]);
  const created = await requireEnrollee(hmoId, id);
  await recordActivity(hmoId, actor, {
    action: 'member.created',
    entityType: 'member',
    entityId: id,
    summary: `Added member ${code}${fullName(created) ? ` (${fullName(created)})` : ''} to ${plan.name}`,
  });
  return created;
}

export async function updateEnrollee(
  hmoId: string,
  enrolleeId: string,
  input: z.infer<typeof updateEnrolleeSchema>,
  actor: Actor,
) {
  const current = await requireEnrollee(hmoId, enrolleeId);
  if (input.planId) await requirePlan(hmoId, input.planId);
  const { userId, ...fields } = input;
  const changes: Partial<Enrollee> = { ...fields };
  if (fields.phone !== undefined) changes.phone = normalisePhone(fields.phone);
  if (fields.email !== undefined) changes.email = normaliseEmail(fields.email);
  if (userId !== undefined && userId !== current.userId) {
    if (userId) {
      const [account] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, userId));
      if (!account || account.role !== 'user') throw badRequest('Choose a patient account to link');
    }
    Object.assign(
      changes,
      userId
        ? { userId, linkedAt: new Date(), linkMethod: 'admin' }
        : { userId: null, linkedAt: null, linkMethod: null },
    );
  }
  try {
    if (Object.keys(changes).length)
      await db.update(hmoEnrollees).set(changes).where(eq(hmoEnrollees.id, enrolleeId));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw accountTaken();
    throw err;
  }
  const updated = await requireEnrollee(hmoId, enrolleeId);
  // Account ids are ours, not the HMO's: the trail records only whether the member is linked.
  const diff = changedFields(
    { ...current, linked: current.userId !== null },
    { ...updated, linked: updated.userId !== null },
    [...MEMBER_FIELDS, 'linked'],
  );
  if (Object.keys(diff).length) {
    await recordActivity(hmoId, actor, {
      action: 'member.updated',
      entityType: 'member',
      entityId: enrolleeId,
      summary: `Updated member ${current.enrolleeCode}: ${describeChanges(diff, MEMBER_LABELS, ['status', 'linked'])}`,
      details: { changes: diff },
    });
  }
  return updated;
}

/**
 * Links unlinked roster entries to existing patient accounts that share the
 * email or phone number, when exactly one account matches and it isn't linked
 * elsewhere. Later sign-ups are matched when they first use the app.
 */
async function matchAccounts(hmoId: string, enrolleeIds?: string[]) {
  const pending = await db
    .select()
    .from(hmoEnrollees)
    .where(
      and(
        eq(hmoEnrollees.hmoId, hmoId),
        isNull(hmoEnrollees.userId),
        isNull(hmoEnrollees.linkedAt),
        eq(hmoEnrollees.status, 'active'),
        enrolleeIds ? inArray(hmoEnrollees.id, enrolleeIds) : undefined,
      ),
    );
  if (!pending.length) return 0;
  const emails = [...new Set(pending.map((e) => e.email).filter((v): v is string => Boolean(v)))];
  const phones = [...new Set(pending.map((e) => e.phone).filter((v): v is string => Boolean(v)))];
  if (!emails.length && !phones.length) return 0;
  const candidates = await db
    .select({ id: users.id, email: users.email, phone: users.phoneNumber, country: users.country })
    .from(users)
    .where(
      and(
        eq(users.role, 'user'),
        or(
          emails.length ? inArray(users.email, emails) : undefined,
          phones.length ? inArray(users.phoneNumber, phones) : undefined,
        ),
      ),
    );
  const alreadyLinked = new Set(
    (
      await db
        .select({ userId: hmoEnrollees.userId })
        .from(hmoEnrollees)
        .where(isNotNull(hmoEnrollees.userId))
    ).map((r) => r.userId),
  );
  let matched = 0;
  for (const enrollee of pending) {
    const accounts = candidates.filter(
      (u) =>
        (enrollee.email && u.email?.toLowerCase() === enrollee.email) ||
        (enrollee.phone && toE164(u.phone, u.country ?? 'NG') === enrollee.phone),
    );
    if (accounts.length !== 1 || alreadyLinked.has(accounts[0]!.id)) continue;
    try {
      const done = await db
        .update(hmoEnrollees)
        .set({ userId: accounts[0]!.id, linkedAt: new Date(), linkMethod: 'match' })
        .where(and(eq(hmoEnrollees.id, enrollee.id), isNull(hmoEnrollees.userId)));
      if (affectedRows(done) > 0) {
        alreadyLinked.add(accounts[0]!.id);
        matched++;
      }
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  return matched;
}

/**
 * Applies an HMO's member list: new codes are added, known codes updated (and
 * re-activated), and with `endMissing` members of the plan absent from the
 * file are ended. Row problems are reported, never fatal to the batch.
 */
export async function importEnrollees(
  hmoId: string,
  input: z.infer<typeof importSchema>,
  actor: Actor,
) {
  const plan = await requirePlan(hmoId, input.planId);
  const errors: Array<{ row: number; code: string; message: string }> = [];
  const seen = new Set<string>();
  const rows: Array<{ code: string; values: Partial<Enrollee> }> = [];

  input.rows.forEach((r, i) => {
    const code = normaliseCode(r.enrolleeCode);
    if (seen.has(code)) {
      errors.push({ row: i + 1, code, message: 'Duplicate enrollee code in the file' });
      return;
    }
    seen.add(code);
    const dateOfBirth = parseDate(r.dateOfBirth);
    if (r.dateOfBirth?.trim() && !dateOfBirth)
      errors.push({
        row: i + 1,
        code,
        message: `Unreadable date of birth "${r.dateOfBirth}" (left blank)`,
      });
    const validTo = parseDate(r.validTo);
    if (r.validTo?.trim() && !validTo)
      errors.push({ row: i + 1, code, message: `Unreadable end date "${r.validTo}" (left blank)` });
    const email =
      r.email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())
        ? normaliseEmail(r.email)
        : null;
    if (r.email?.trim() && !email)
      errors.push({ row: i + 1, code, message: `Invalid email "${r.email}" (left blank)` });
    rows.push({
      code,
      values: {
        planId: input.planId,
        firstName: r.firstName ?? null,
        lastName: r.lastName ?? null,
        phone: normalisePhone(r.phone),
        email,
        dateOfBirth,
        // End of that day in Lagos (WAT, UTC+1), so 31/12/2027 means covered through New Year's Eve.
        validTo: validTo ? new Date(`${validTo}T23:59:59.999+01:00`) : null,
        status: 'active',
      },
    });
  });

  const existing = await db
    .select({ id: hmoEnrollees.id, code: hmoEnrollees.enrolleeCode })
    .from(hmoEnrollees)
    .where(eq(hmoEnrollees.hmoId, hmoId));
  const idByCode = new Map(existing.map((e) => [e.code.toUpperCase(), e.id]));
  const created: string[] = [];
  let updated = 0;

  await db.transaction(async (tx) => {
    const fresh = rows
      .filter((r) => !idByCode.has(r.code))
      .map((r) => ({
        id: newId(),
        hmoId,
        enrolleeCode: r.code,
        planId: input.planId,
        ...r.values,
      }));
    for (let i = 0; i < fresh.length; i += 500)
      await tx.insert(hmoEnrollees).values(fresh.slice(i, i + 500));
    created.push(...fresh.map((f) => f.id));
    for (const r of rows.filter((row) => idByCode.has(row.code))) {
      await tx
        .update(hmoEnrollees)
        .set(r.values)
        .where(eq(hmoEnrollees.id, idByCode.get(r.code)!));
      updated++;
    }
  });

  let ended = 0;
  if (input.endMissing && seen.size) {
    const result = await db
      .update(hmoEnrollees)
      .set({ status: 'ended' })
      .where(
        and(
          eq(hmoEnrollees.hmoId, hmoId),
          eq(hmoEnrollees.planId, input.planId),
          eq(hmoEnrollees.status, 'active'),
          notInArray(hmoEnrollees.enrolleeCode, [...seen]),
        ),
      );
    ended = affectedRows(result);
  }
  const matched = await matchAccounts(hmoId);
  const result = { created: created.length, updated, ended, matched, errors };
  await recordActivity(hmoId, actor, {
    action: 'members.imported',
    entityType: 'plan',
    entityId: plan.id,
    summary: `Imported ${input.rows.length.toLocaleString('en-NG')} rows into ${plan.name}: ${created.length} added, ${updated} updated${input.endMissing ? `, ${ended} ended` : ''}`,
    details: { ...result, errors: errors.length, endMissing: input.endMissing },
  });
  return result;
}

// ── "Link my HMO" requests that need a person ───────────────────────────────

export async function listLinkRequests(query: z.infer<typeof linkRequestsQuery>, hmoId?: string) {
  const where = and(
    eq(hmoLinkRequests.status, query.status),
    hmoId ? eq(hmoLinkRequests.hmoId, hmoId) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select({
        id: hmoLinkRequests.id,
        hmoId: hmoLinkRequests.hmoId,
        hmoName: hmos.name,
        enrolleeCode: hmoLinkRequests.enrolleeCode,
        reason: hmoLinkRequests.reason,
        details: hmoLinkRequests.details,
        status: hmoLinkRequests.status,
        reviewNote: hmoLinkRequests.reviewNote,
        reviewedAt: hmoLinkRequests.reviewedAt,
        createdAt: hmoLinkRequests.createdAt,
        userId: users.id,
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userEmail: users.email,
        userPhone: users.phoneNumber,
      })
      .from(hmoLinkRequests)
      .innerJoin(hmos, eq(hmos.id, hmoLinkRequests.hmoId))
      .innerJoin(users, eq(users.id, hmoLinkRequests.userId))
      .where(where)
      .orderBy(desc(hmoLinkRequests.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(hmoLinkRequests).where(where),
  ]);
  return { items, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

async function requirePendingRequest(requestId: string) {
  const [request] = await db
    .select()
    .from(hmoLinkRequests)
    .where(eq(hmoLinkRequests.id, requestId))
    .limit(1);
  if (!request) throw notFound('Link request');
  if (request.status !== 'pending')
    throw conflict('LINK_REQUEST_CLOSED', 'This request has already been reviewed');
  return request;
}

/** Links the requester to the roster entry the admin chose. */
export async function approveLinkRequest(adminId: string, requestId: string, enrolleeId: string) {
  const request = await requirePendingRequest(requestId);
  const enrollee = await requireEnrollee(request.hmoId, enrolleeId);
  if (enrollee.userId && enrollee.userId !== request.userId) {
    throw conflict(
      'ENROLLEE_ALREADY_LINKED',
      'That membership is linked to another account. Unlink it from the enrollee list first.',
    );
  }
  try {
    await db.transaction(async (tx) => {
      // One membership per account: approving moves the patient off any previous HMO.
      await tx
        .update(hmoEnrollees)
        .set({ userId: null, linkedAt: null, linkMethod: null })
        .where(eq(hmoEnrollees.userId, request.userId));
      await tx
        .update(hmoEnrollees)
        .set({ userId: request.userId, linkedAt: new Date(), linkMethod: 'self' })
        .where(eq(hmoEnrollees.id, enrolleeId));
      await tx
        .update(hmoLinkRequests)
        .set({ status: 'approved', reviewedBy: adminId, reviewedAt: new Date() })
        .where(eq(hmoLinkRequests.id, requestId));
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw accountTaken();
    throw err;
  }
  return { approved: true };
}

export async function rejectLinkRequest(adminId: string, requestId: string, note?: string | null) {
  await requirePendingRequest(requestId);
  await db
    .update(hmoLinkRequests)
    .set({
      status: 'rejected',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNote: note ?? null,
    })
    .where(eq(hmoLinkRequests.id, requestId));
  return { rejected: true };
}
