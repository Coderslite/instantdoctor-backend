import { and, count, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  appointmentPackages,
  hmoAuthorizations,
  hmoEnrollees,
  hmoPlans,
  hmos,
  users,
  type HmoAuthorizationStatus,
  type HmoService,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { sendPush } from '../../integrations/push.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { round2 } from '../../lib/money.js';
import { standardLabPrice } from '../lab-results/lab-results.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { recordActivity, type Actor } from './hmo.activity.js';
import { requireHmo, standardConsultationPrice } from './hmo.agreements.js';
import { coverageFor, membershipFor } from './hmo.coverage.js';

/**
 * Pre-authorisation, as HMOs run it: above the agreed amount a member asks
 * the HMO to approve a service first; the HMO approves (issuing a PA code) or
 * declines in its portal, or Instant Doctor does on its behalf. The next
 * matching use consumes the approval automatically (see hmo.coverage).
 */

export const APPROVAL_VALID_DAYS = 14;

const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

/** "expired" is derived: approved but past its date. */
const statusOf = (row: { status: HmoAuthorizationStatus; expiresAt: Date | null }) =>
  row.status === 'approved' && row.expiresAt && row.expiresAt <= new Date() ? 'expired' : row.status;

async function patientName(userId: string) {
  const [u] = await db.select({ firstName: users.firstName, lastName: users.lastName, token: users.fcmToken }).from(users).where(eq(users.id, userId));
  return { name: `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || 'A member', token: u?.token ?? null };
}

// ── Members ─────────────────────────────────────────────────────────────────

export async function requestAuthorization(
  userId: string,
  input: { service: HmoService; packageId?: string | null; amount?: number | null; note?: string | null },
) {
  const membership = await membershipFor(userId);
  if (!membership) throw notFound('HMO membership');
  let standard: number;
  let description: string;
  const packageId = input.service === 'consultation' ? (input.packageId ?? null) : null;
  if (input.service === 'consultation') {
    if (!packageId) throw badRequest('Choose the consultation package');
    const [pkg] = await db.select().from(appointmentPackages).where(and(eq(appointmentPackages.id, packageId), eq(appointmentPackages.isActive, true)));
    if (!pkg) throw notFound('Consultation package');
    standard = await standardConsultationPrice(pkg.amountUsd);
    description = `${pkg.name} consultation`;
  } else if (input.service === 'lab_interpretation') {
    const price = await standardLabPrice();
    if (price === null) throw unprocessable('NOT_PRICED', 'Lab interpretation is not available right now');
    standard = price;
    description = 'Lab result interpretation';
  } else {
    if (!input.amount || input.amount <= 0) throw badRequest('Enter the cost of the prescribed medicines');
    standard = round2(input.amount);
    description = `Prescribed medicines (${naira(standard)})`;
  }

  const check = await coverageFor(userId, input.service, packageId, standard, { membership, ignoreAuthorization: true });
  const decision = check.decision;
  if (!decision) throw unprocessable('NOT_COVERED', check.message ?? `Not covered by your ${membership.hmo.name} plan`);
  const rule = decision.rule;
  const value = round2(rule.billing === 'capitation' ? standard - decision.patientAmount : decision.hmoAmount);
  if (rule.authorizationAbove == null || (rule.authorizationAbove > 0 && value <= rule.authorizationAbove))
    throw conflict('APPROVAL_NOT_NEEDED', `${membership.hmo.name} doesn’t need to approve this. You can go ahead.`);

  // One open request per service (and package) at a time.
  const [open] = await db
    .select()
    .from(hmoAuthorizations)
    .where(
      and(
        eq(hmoAuthorizations.enrolleeId, membership.enrollee.id),
        eq(hmoAuthorizations.service, input.service),
        eq(hmoAuthorizations.status, 'pending'),
        packageId ? eq(hmoAuthorizations.packageId, packageId) : isNull(hmoAuthorizations.packageId),
      ),
    )
    .limit(1);
  if (open) return serialize(open, membership.hmo.name);

  const id = newId();
  await db.insert(hmoAuthorizations).values({
    id,
    hmoId: membership.hmo.id,
    planId: membership.plan.id,
    ruleId: rule.id,
    enrolleeId: membership.enrollee.id,
    userId,
    service: input.service,
    packageId,
    description,
    patientNote: input.note?.trim() || null,
    standardAmount: standard,
    requestedAmount: value,
  });
  const patient = await patientName(userId);
  await recordActivity(membership.hmo.id, { type: 'system', id: null, name: patient.name }, {
    action: 'authorization.requested',
    entityType: 'authorization',
    entityId: id,
    summary: `${patient.name} (${membership.enrollee.enrolleeCode}) asked for approval: ${description}, ${naira(value)}`,
  });
  const [hmo] = await db.select({ email: hmos.contactEmail }).from(hmos).where(eq(hmos.id, membership.hmo.id));
  if (hmo?.email)
    void mailer
      .hmoAuthorizationRequested({
        to: hmo.email,
        hmoName: membership.hmo.name,
        patientName: patient.name,
        enrolleeCode: membership.enrollee.enrolleeCode,
        planName: membership.plan.name,
        description,
        amount: value,
        note: input.note?.trim() || null,
      })
      .catch((err: unknown) => logger.error({ err, id }, 'Approval request email failed'));
  const [row] = await db.select().from(hmoAuthorizations).where(eq(hmoAuthorizations.id, id));
  return serialize(row!, membership.hmo.name);
}

function serialize(row: typeof hmoAuthorizations.$inferSelect, hmoName: string) {
  return {
    id: row.id,
    hmoName,
    service: row.service,
    packageId: row.packageId,
    description: row.description,
    status: statusOf(row),
    code: row.code,
    hmoReference: row.hmoReference,
    requestedAmount: row.requestedAmount,
    approvedAmount: row.approvedAmount,
    decisionNote: row.decisionNote,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
  };
}

export async function myAuthorizations(userId: string) {
  const rows = await db
    .select({ row: hmoAuthorizations, hmoName: hmos.name })
    .from(hmoAuthorizations)
    .innerJoin(hmos, eq(hmos.id, hmoAuthorizations.hmoId))
    .where(eq(hmoAuthorizations.userId, userId))
    .orderBy(desc(hmoAuthorizations.createdAt))
    .limit(50);
  return rows.map((r) => serialize(r.row, r.hmoName));
}

export async function cancelMine(userId: string, id: string) {
  const [row] = await db.select().from(hmoAuthorizations).where(and(eq(hmoAuthorizations.id, id), eq(hmoAuthorizations.userId, userId)));
  if (!row) throw notFound('Approval request');
  if (row.status !== 'pending') throw badRequest('Only a request still waiting for the HMO can be cancelled');
  await db.update(hmoAuthorizations).set({ status: 'cancelled' }).where(eq(hmoAuthorizations.id, id));
  const [hmo] = await db.select({ name: hmos.name }).from(hmos).where(eq(hmos.id, row.hmoId));
  return serialize({ ...row, status: 'cancelled' }, hmo?.name ?? 'HMO');
}

// ── The HMO (portal) and Instant Doctor on its behalf ───────────────────────

export async function listAuthorizations(
  hmoId: string,
  query: { status?: HmoAuthorizationStatus | 'expired'; limit: number; offset: number },
) {
  await requireHmo(hmoId);
  const now = new Date();
  const where = and(
    eq(hmoAuthorizations.hmoId, hmoId),
    query.status === 'expired'
      ? and(eq(hmoAuthorizations.status, 'approved'), sql`${hmoAuthorizations.expiresAt} <= ${now}`)
      : query.status === 'approved'
        ? and(eq(hmoAuthorizations.status, 'approved'), or(isNull(hmoAuthorizations.expiresAt), gt(hmoAuthorizations.expiresAt, now)))
        : query.status
          ? eq(hmoAuthorizations.status, query.status)
          : undefined,
  );
  const [rows, [total], [pending]] = await Promise.all([
    db
      .select({
        row: hmoAuthorizations,
        patientName: sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`,
        enrolleeCode: hmoEnrollees.enrolleeCode,
        planName: hmoPlans.name,
      })
      .from(hmoAuthorizations)
      .innerJoin(users, eq(users.id, hmoAuthorizations.userId))
      .innerJoin(hmoEnrollees, eq(hmoEnrollees.id, hmoAuthorizations.enrolleeId))
      .leftJoin(hmoPlans, eq(hmoPlans.id, hmoAuthorizations.planId))
      .where(where)
      .orderBy(desc(hmoAuthorizations.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(hmoAuthorizations).where(where),
    db.select({ n: count() }).from(hmoAuthorizations).where(and(eq(hmoAuthorizations.hmoId, hmoId), eq(hmoAuthorizations.status, 'pending'))),
  ]);
  return {
    items: rows.map((r) => ({
      ...r.row,
      status: statusOf(r.row),
      patientName: r.patientName,
      enrolleeCode: r.enrolleeCode,
      planName: r.planName,
    })),
    total: total?.n ?? 0,
    pending: pending?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export type AuthorizationDecision =
  | { action: 'approve'; validDays?: number; hmoReference?: string | null; note?: string | null }
  | { action: 'reject'; note: string };

export async function decideAuthorization(hmoId: string, id: string, input: AuthorizationDecision, actor: Actor) {
  const hmo = await requireHmo(hmoId);
  const [row] = await db.select().from(hmoAuthorizations).where(and(eq(hmoAuthorizations.id, id), eq(hmoAuthorizations.hmoId, hmoId)));
  if (!row) throw notFound('Approval request');
  if (row.status !== 'pending') throw conflict('ALREADY_DECIDED', `This request is already ${statusOf(row)}`);
  const now = new Date();
  let code: string | null = null;
  if (input.action === 'approve') {
    const days = input.validDays ?? APPROVAL_VALID_DAYS;
    for (let attempt = 0; ; attempt++) {
      code = `PA-${hmo.code}-${randomCode(6)}`;
      try {
        await db
          .update(hmoAuthorizations)
          .set({
            status: 'approved',
            code,
            approvedAmount: row.requestedAmount,
            hmoReference: input.hmoReference?.trim() || null,
            decisionNote: input.note?.trim() || null,
            decidedBy: actor.name,
            decidedAt: now,
            expiresAt: new Date(now.getTime() + days * 24 * 3600_000),
          })
          .where(and(eq(hmoAuthorizations.id, id), eq(hmoAuthorizations.status, 'pending')));
        break;
      } catch (err) {
        if (isDuplicateKeyError(err) && attempt < 3) continue;
        throw err;
      }
    }
  } else {
    await db
      .update(hmoAuthorizations)
      .set({ status: 'rejected', decisionNote: input.note.trim(), decidedBy: actor.name, decidedAt: now })
      .where(and(eq(hmoAuthorizations.id, id), eq(hmoAuthorizations.status, 'pending')));
  }
  const patient = await patientName(row.userId);
  const approved = input.action === 'approve';
  await recordActivity(hmoId, actor, {
    action: approved ? 'authorization.approved' : 'authorization.rejected',
    entityType: 'authorization',
    entityId: id,
    summary: approved
      ? `Approved ${row.description} for ${patient.name} — ${code}`
      : `Declined ${row.description} for ${patient.name}: ${(input as { note: string }).note}`,
  });
  const title = approved ? `${hmo.name} approved your request` : `${hmo.name} declined your request`;
  const body = approved
    ? `${row.description} is approved (${code}). Go ahead and book — your cover is applied automatically.`
    : `${row.description} wasn’t approved${(input as { note?: string }).note ? `: ${(input as { note: string }).note}` : ''}. You can still go ahead at the normal price.`;
  try {
    await createNotification({ userId: row.userId, type: 'transaction', title: `${title}: ${row.description}` });
  } catch (err) {
    logger.error({ err, id }, 'Approval notification failed');
  }
  void sendPush([patient.token], { title, body, data: { type: 'hmo', id } }).catch((err: unknown) =>
    logger.error({ err, id }, 'Approval push failed'),
  );
  const [updated] = await db.select().from(hmoAuthorizations).where(eq(hmoAuthorizations.id, id));
  return { ...updated!, status: statusOf(updated!) };
}
