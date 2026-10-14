import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  like,
  lt,
  ne,
  notInArray,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import type { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  appointments,
  hmoCapitationLines,
  hmoClaims,
  hmoInvoices,
  hmoPlans,
  labResults,
  orders,
  users,
} from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';
import { recordActivity, type Actor } from './hmo.activity.js';
import { requireHmo } from './hmo.agreements.js';
import { capitationDue } from './hmo.capitation.js';
import type {
  claimUpdateSchema,
  claimsQuery,
  invoiceSchema,
  invoiceUpdateSchema,
} from './hmo.schemas.js';

/**
 * Claims (one per covered service) and the invoices that bill them. Scoped to
 * one HMO throughout, so an HMO portal can reuse these reads directly.
 */

/**
 * The covered service actually happened: a paid, uncancelled consultation, a
 * paid lab interpretation, or a medicine order that was delivered.
 */
export const serviceStands = () =>
  or(
    and(
      sql`${appointments.id} IS NOT NULL`,
      eq(appointments.isPaid, true),
      notInArray(appointments.status, ['cancelled', 'deleted']),
    ),
    and(sql`${labResults.id} IS NOT NULL`, ne(labResults.status, 'awaiting_payment')),
    and(sql`${orders.id} IS NOT NULL`, eq(orders.status, 'completed')),
  );

const serviceState = sql<'confirmed' | 'awaiting_payment' | 'in_progress' | 'cancelled'>`CASE
  WHEN ${appointments.id} IS NOT NULL AND ${appointments.status} IN ('cancelled', 'deleted') THEN 'cancelled'
  WHEN ${appointments.id} IS NOT NULL AND ${appointments.isPaid} = false THEN 'awaiting_payment'
  WHEN ${labResults.id} IS NOT NULL AND ${labResults.status} = 'awaiting_payment' THEN 'awaiting_payment'
  WHEN ${orders.id} IS NOT NULL AND ${orders.status} = 'cancelled' THEN 'cancelled'
  WHEN ${orders.id} IS NOT NULL AND ${orders.status} = 'awaiting_payment' THEN 'awaiting_payment'
  WHEN ${orders.id} IS NOT NULL AND ${orders.status} <> 'completed' THEN 'in_progress'
  ELSE 'confirmed' END`;

/** Periods and filters are whole days in Lagos (WAT, UTC+1), matching what the admin sees. */
const dayStart = (d: string) => new Date(`${d}T00:00:00.000+01:00`);
const nextDay = (d: string) => new Date(dayStart(d).getTime() + 24 * 3600_000);

export async function listClaims(hmoId: string, query: z.infer<typeof claimsQuery>) {
  await requireHmo(hmoId);
  const term = query.search ? `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = and(
    eq(hmoClaims.hmoId, hmoId),
    query.status ? eq(hmoClaims.status, query.status) : undefined,
    query.service ? eq(hmoClaims.service, query.service) : undefined,
    query.enrolleeId ? eq(hmoClaims.enrolleeId, query.enrolleeId) : undefined,
    term
      ? or(
          like(hmoClaims.enrolleeCode, term),
          sql`CONCAT(${users.firstName}, ' ', ${users.lastName}) LIKE ${term}`,
        )
      : undefined,
    query.from ? gte(hmoClaims.serviceDate, dayStart(query.from)) : undefined,
    query.to ? lt(hmoClaims.serviceDate, nextDay(query.to)) : undefined,
  );
  const base = () =>
    db
      .select({
        id: hmoClaims.id,
        service: hmoClaims.service,
        description: hmoClaims.description,
        enrolleeId: hmoClaims.enrolleeId,
        enrolleeCode: hmoClaims.enrolleeCode,
        patientName: sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`,
        coverage: hmoClaims.coverage,
        standardAmount: hmoClaims.standardAmount,
        patientAmount: hmoClaims.patientAmount,
        hmoAmount: hmoClaims.hmoAmount,
        doctorEarning: hmoClaims.doctorEarning,
        currency: hmoClaims.currency,
        status: hmoClaims.status,
        statusNote: hmoClaims.statusNote,
        invoiceId: hmoClaims.invoiceId,
        appointmentId: hmoClaims.appointmentId,
        labResultId: hmoClaims.labResultId,
        orderId: hmoClaims.orderId,
        billing: hmoClaims.billing,
        authorizationCode: hmoClaims.authorizationCode,
        serviceDate: hmoClaims.serviceDate,
        serviceState,
      })
      .from(hmoClaims)
      .innerJoin(users, eq(users.id, hmoClaims.userId))
      .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
      .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
      .leftJoin(orders, eq(orders.id, hmoClaims.orderId));
  const [items, [total], totals] = await Promise.all([
    base()
      .where(where)
      .orderBy(desc(hmoClaims.serviceDate))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ n: count() })
      .from(hmoClaims)
      .innerJoin(users, eq(users.id, hmoClaims.userId))
      .where(where),
    db
      .select({
        status: hmoClaims.status,
        n: count(),
        amount: sum(hmoClaims.hmoAmount).mapWith(Number),
      })
      .from(hmoClaims)
      .where(eq(hmoClaims.hmoId, hmoId))
      .groupBy(hmoClaims.status),
  ]);
  return {
    items,
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
    totals: Object.fromEntries(
      totals.map((t) => [t.status, { claims: t.n, amount: t.amount ?? 0 }]),
    ),
  };
}

async function recomputeInvoice(executor: Executor, invoiceId: string) {
  const [row] = await executor
    .select({ n: count(), total: sum(hmoClaims.hmoAmount).mapWith(Number) })
    .from(hmoClaims)
    .where(and(eq(hmoClaims.invoiceId, invoiceId), ne(hmoClaims.status, 'rejected')));
  const [invoice] = await executor
    .select({ capitation: hmoInvoices.capitationAmount })
    .from(hmoInvoices)
    .where(eq(hmoInvoices.id, invoiceId));
  await executor
    .update(hmoInvoices)
    .set({
      claimCount: row?.n ?? 0,
      totalAmount: round2((row?.total ?? 0) + (invoice?.capitation ?? 0)),
    })
    .where(eq(hmoInvoices.id, invoiceId));
}

/**
 * - rejected: the HMO declined it (allowed before or after invoicing; an invoice total drops).
 * - void: our mistake / duplicate (only before invoicing).
 * - unbilled: undo a rejection or void (only when not on an invoice).
 */
const naira = (n: number) => `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const CLAIM_VERB = { rejected: 'Rejected', void: 'Voided', unbilled: 'Restored' } as const;

export async function updateClaim(
  hmoId: string,
  claimId: string,
  input: z.infer<typeof claimUpdateSchema>,
  actor: Actor,
) {
  const [claim] = await db
    .select()
    .from(hmoClaims)
    .where(and(eq(hmoClaims.id, claimId), eq(hmoClaims.hmoId, hmoId)))
    .limit(1);
  if (!claim) throw notFound('Claim');
  if (claim.status === 'paid')
    throw conflict('CLAIM_PAID', 'This claim has been paid and can no longer change');
  if (input.status === 'void' && claim.invoiceId)
    throw conflict('CLAIM_INVOICED', 'Cancel its invoice before voiding this claim');
  if (input.status === 'unbilled' && claim.invoiceId)
    throw conflict('CLAIM_INVOICED', 'This claim is on an invoice; cancel the invoice first');
  await db.transaction(async (tx) => {
    await tx
      .update(hmoClaims)
      .set({ status: input.status, statusNote: input.note ?? null })
      .where(eq(hmoClaims.id, claimId));
    if (claim.invoiceId) await recomputeInvoice(tx, claim.invoiceId);
  });
  const [updated] = await db.select().from(hmoClaims).where(eq(hmoClaims.id, claimId));
  if (input.status !== claim.status) {
    await recordActivity(hmoId, actor, {
      action: `claim.${input.status === 'unbilled' ? 'restored' : input.status}`,
      entityType: 'claim',
      entityId: claimId,
      summary: `${CLAIM_VERB[input.status]} the claim for ${claim.enrolleeCode} — ${claim.description} (${naira(claim.hmoAmount)})${input.note ? `: ${input.note}` : ''}`,
      details: { from: claim.status, to: input.status, note: input.note ?? null },
    });
  }
  return updated;
}

async function nextInvoiceReference(
  executor: Executor,
  hmoId: string,
  code: string,
  now = new Date(),
) {
  const [row] = await executor
    .select({ n: count() })
    .from(hmoInvoices)
    .where(eq(hmoInvoices.hmoId, hmoId));
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `INV/${code}/${now.getUTCFullYear()}/${month}/${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

/**
 * Bills every unbilled, billable claim with a service date in the period —
 * per-use claims and ₦0 capitation encounters (listed for utilisation) — plus
 * capitation for each capitation plan and month starting in the period that
 * hasn't been billed yet.
 */
export async function createInvoice(
  hmoId: string,
  adminId: string | null,
  input: z.infer<typeof invoiceSchema>,
  actor: Actor,
) {
  const hmo = await requireHmo(hmoId);
  const from = dayStart(input.periodStart);
  const to = nextDay(input.periodEnd);
  if (to <= from)
    throw unprocessable('INVALID_PERIOD', 'The period must end on or after its start');
  const id = newId();
  await db.transaction(async (tx) => {
    const eligible = await tx
      .select({ id: hmoClaims.id, amount: hmoClaims.hmoAmount })
      .from(hmoClaims)
      .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
      .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
      .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
      .where(
        and(
          eq(hmoClaims.hmoId, hmoId),
          eq(hmoClaims.status, 'unbilled'),
          or(gt(hmoClaims.hmoAmount, 0), eq(hmoClaims.billing, 'capitation')),
          gte(hmoClaims.serviceDate, from),
          lt(hmoClaims.serviceDate, to),
          serviceStands(),
        ),
      )
      .for('update');
    const capitation = await capitationDue(hmoId, from, to, tx);
    const capitationAmount = round2(capitation.reduce((s, l) => s + l.amount, 0));
    if (!capitation.length && !eligible.some((c) => c.amount > 0))
      throw unprocessable(
        'NOTHING_TO_INVOICE',
        'There are no billable claims or capitation for this HMO in that period',
      );
    const now = new Date();
    await tx.insert(hmoInvoices).values({
      id,
      hmoId,
      reference: await nextInvoiceReference(tx, hmoId, hmo.code, now),
      periodStart: from,
      periodEnd: new Date(to.getTime() - 1),
      claimCount: eligible.length,
      capitationAmount,
      totalAmount: round2(eligible.reduce((s, c) => s + c.amount, 0) + capitationAmount),
      dueAt: new Date(now.getTime() + hmo.paymentTermsDays * 24 * 3600_000),
      notes: input.notes ?? null,
      createdBy: adminId,
    });
    try {
      if (capitation.length)
        await tx.insert(hmoCapitationLines).values(
          capitation.map((l) => ({
            id: newId(),
            invoiceId: id,
            hmoId,
            planId: l.planId,
            month: l.month,
            members: l.members,
            rate: l.rate,
            amount: l.amount,
          })),
        );
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw conflict('CAPITATION_ALREADY_BILLED', 'Another invoice just billed this capitation. Refresh and try again.');
      throw err;
    }
    for (let i = 0; i < eligible.length; i += 500) {
      await tx
        .update(hmoClaims)
        .set({ status: 'invoiced', invoiceId: id })
        .where(
          inArray(
            hmoClaims.id,
            eligible.slice(i, i + 500).map((c) => c.id),
          ),
        );
    }
  });
  const invoice = await getInvoice(hmoId, id);
  await recordActivity(hmoId, actor, {
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: id,
    summary: `Issued invoice ${invoice.reference} for ${naira(invoice.totalAmount)} (${[
      `${invoice.claimCount} claim${invoice.claimCount === 1 ? '' : 's'}`,
      invoice.capitationAmount > 0 ? `capitation ${naira(invoice.capitationAmount)}` : null,
    ]
      .filter(Boolean)
      .join(', ')}, ${input.periodStart} to ${input.periodEnd})`,
  });
  return invoice;
}

export async function listInvoices(hmoId: string) {
  await requireHmo(hmoId);
  return db
    .select()
    .from(hmoInvoices)
    .where(eq(hmoInvoices.hmoId, hmoId))
    .orderBy(desc(hmoInvoices.createdAt));
}

export async function getInvoice(hmoId: string, invoiceId: string) {
  const [invoice] = await db
    .select()
    .from(hmoInvoices)
    .where(and(eq(hmoInvoices.id, invoiceId), eq(hmoInvoices.hmoId, hmoId)))
    .limit(1);
  if (!invoice) throw notFound('Invoice');
  const claims = await db
    .select({
      id: hmoClaims.id,
      serviceDate: hmoClaims.serviceDate,
      enrolleeCode: hmoClaims.enrolleeCode,
      patientName: sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`,
      description: hmoClaims.description,
      authorizationCode: hmoClaims.authorizationCode,
      standardAmount: hmoClaims.standardAmount,
      patientAmount: hmoClaims.patientAmount,
      hmoAmount: hmoClaims.hmoAmount,
      status: hmoClaims.status,
      statusNote: hmoClaims.statusNote,
    })
    .from(hmoClaims)
    .innerJoin(users, eq(users.id, hmoClaims.userId))
    .where(eq(hmoClaims.invoiceId, invoiceId))
    .orderBy(hmoClaims.serviceDate);
  const capitation = await db
    .select({
      id: hmoCapitationLines.id,
      planId: hmoCapitationLines.planId,
      planName: hmoPlans.name,
      month: hmoCapitationLines.month,
      members: hmoCapitationLines.members,
      rate: hmoCapitationLines.rate,
      amount: hmoCapitationLines.amount,
    })
    .from(hmoCapitationLines)
    .innerJoin(hmoPlans, eq(hmoPlans.id, hmoCapitationLines.planId))
    .where(eq(hmoCapitationLines.invoiceId, invoiceId))
    .orderBy(hmoCapitationLines.month, hmoPlans.name);
  return { ...invoice, claims, capitation };
}

/** paid: settles its claims. cancelled: releases them to be billed again. */
export async function updateInvoice(
  hmoId: string,
  invoiceId: string,
  input: z.infer<typeof invoiceUpdateSchema>,
  actor: Actor,
) {
  const invoice = await getInvoice(hmoId, invoiceId);
  if (invoice.status !== 'issued')
    throw conflict('INVOICE_CLOSED', `This invoice is already ${invoice.status}`);
  await db.transaction(async (tx) => {
    if (input.status === 'paid') {
      await tx
        .update(hmoInvoices)
        .set({
          status: 'paid',
          paidAt: new Date(),
          paymentReference: input.paymentReference ?? null,
        })
        .where(eq(hmoInvoices.id, invoiceId));
      await tx
        .update(hmoClaims)
        .set({ status: 'paid' })
        .where(and(eq(hmoClaims.invoiceId, invoiceId), eq(hmoClaims.status, 'invoiced')));
    } else {
      await tx
        .update(hmoInvoices)
        .set({ status: 'cancelled' })
        .where(eq(hmoInvoices.id, invoiceId));
      await tx
        .update(hmoClaims)
        .set({ status: 'unbilled', invoiceId: null })
        .where(and(eq(hmoClaims.invoiceId, invoiceId), eq(hmoClaims.status, 'invoiced')));
      await tx.update(hmoClaims).set({ invoiceId: null }).where(eq(hmoClaims.invoiceId, invoiceId));
      // Free its capitation months to be billed again.
      await tx.delete(hmoCapitationLines).where(eq(hmoCapitationLines.invoiceId, invoiceId));
    }
  });
  await recordActivity(hmoId, actor, {
    action: `invoice.${input.status}`,
    entityType: 'invoice',
    entityId: invoiceId,
    summary:
      input.status === 'paid'
        ? `Recorded payment of invoice ${invoice.reference} (${naira(invoice.totalAmount)})${input.paymentReference ? `, ref ${input.paymentReference}` : ''}`
        : `Cancelled invoice ${invoice.reference}; its claims${invoice.capitation.length ? ' and capitation' : ''} can be billed again`,
  });
  return getInvoice(hmoId, invoiceId);
}
