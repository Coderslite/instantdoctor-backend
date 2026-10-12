import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { labResultFiles, labResults, serviceCharges, users } from '../../db/schema/index.js';
import { notFound, serviceUnavailable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { attachFile, resolveFileUrls } from '../files/files.service.js';
import { quoteFromUsd, resolveRegion } from '../pricing/pricing.service.js';
import { coverageFor, recordClaim, type CoverageDecision } from '../hmo/hmo.coverage.js';
import { NIGERIA } from '../hmo/hmo.pricing.js';
import { round2 } from '../../lib/money.js';

/** Firestore `Charges` type for lab interpretation (legacy spelling preserved). */
export const LAB_CHARGE_TYPE = 'LapResult';

export async function quoteForUser(userId: string) {
  const [[charge], [user]] = await Promise.all([
    db.select().from(serviceCharges).where(eq(serviceCharges.type, LAB_CHARGE_TYPE)).limit(1),
    db
      .select({ country: users.country, currency: users.currency })
      .from(users)
      .where(eq(users.id, userId)),
  ]);
  if (!charge) throw serviceUnavailable('Lab result pricing is not configured');
  if (!user) throw notFound('User');
  return quoteFromUsd(charge.amountUsd, resolveRegion(user));
}

/** The normal interpretation price in naira (the basis HMO agreements are applied to). */
export async function standardLabPrice() {
  const [charge] = await db
    .select()
    .from(serviceCharges)
    .where(eq(serviceCharges.type, LAB_CHARGE_TYPE))
    .limit(1);
  return charge ? (await quoteFromUsd(charge.amountUsd, NIGERIA)).amount : null;
}

/**
 * What this patient pays for an interpretation: the regional price, or their
 * HMO agreement's price when their plan covers it.
 */
export async function priceForUser(userId: string, opts: { enforce?: boolean } = {}) {
  const quote = await quoteForUser(userId);
  const standardNgn = await standardLabPrice();
  const check =
    standardNgn === null
      ? null
      : await coverageFor(userId, 'lab_interpretation', null, standardNgn, {
          enforce: opts.enforce,
        });
  const decision: CoverageDecision | null = check?.decision ?? null;
  if (!decision)
    return {
      quote,
      decision: null,
      hmo: check?.membership
        ? { covered: false, hmoName: check.membership.hmo.name, notice: check.notice }
        : null,
    };
  return {
    quote: {
      ...quote,
      amount: decision.patientAmount,
      currency: 'NGN',
      amountUsd: round2(decision.patientAmount / (await quoteFromUsd(1, NIGERIA)).exchangeRate),
    },
    decision,
    hmo: {
      covered: true,
      hmoName: decision.membership.hmo.name,
      summary: decision.summary,
      standardPrice: decision.standardAmount,
      usage: decision.usage,
    },
  };
}

async function withFiles(rows: Array<typeof labResults.$inferSelect>) {
  if (rows.length === 0) return [];
  const files = await db
    .select()
    .from(labResultFiles)
    .where(
      inArray(
        labResultFiles.labResultId,
        rows.map((r) => r.id),
      ),
    );
  const urls = await resolveFileUrls([
    ...files.map((f) => f.fileUrl),
    ...rows.map((r) => r.resultUrl),
  ]);
  const url = (value: string | null) =>
    value ? (urls.get(value) ?? (value.startsWith('file:') ? null : value)) : null;
  return rows.map((r) => ({
    ...r,
    resultUrl: url(r.resultUrl),
    files: files
      .filter((f) => f.labResultId === r.id)
      .map((f) => ({ fileUrl: url(f.fileUrl), fileType: f.fileType })),
  }));
}

/**
 * Submits files for interpretation with a server-side quote. Paid results start
 * `awaiting_payment`; pay with POST /payments { purpose: "lab_result" }.
 */
export async function createLabResult(
  userId: string,
  submitted: Array<{ fileId?: string; fileUrl?: string; fileType: string }>,
) {
  const files = await Promise.all(
    submitted.map(async (f) => ({
      fileType: f.fileType,
      fileUrl: f.fileId
        ? await attachFile({ kind: 'patient', id: userId }, f.fileId, ['lab_result'])
        : f.fileUrl!,
    })),
  );
  const { quote, decision } = await priceForUser(userId, { enforce: true });
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(labResults).values({
      id,
      userId,
      status: quote.amount > 0 ? 'awaiting_payment' : 'pending',
      price: quote.amount,
      currency: quote.currency,
    });
    await tx
      .insert(labResultFiles)
      .values(files.map((f) => ({ id: newId(), labResultId: id, ...f })));
    if (decision)
      await recordClaim(tx, {
        userId,
        decision,
        labResultId: id,
        description: 'Lab result interpretation',
      });
  });
  const [row] = await db.select().from(labResults).where(eq(labResults.id, id));
  return (await withFiles([row!]))[0]!;
}

export async function listLabResults(userId: string) {
  const rows = await db
    .select()
    .from(labResults)
    .where(eq(labResults.userId, userId))
    .orderBy(desc(labResults.createdAt));
  return withFiles(rows);
}

export async function markOpened(userId: string, id: string) {
  await db
    .update(labResults)
    .set({ opened: true })
    .where(and(eq(labResults.id, id), eq(labResults.userId, userId)));
}

export async function deleteLabResult(userId: string, id: string) {
  await db.delete(labResults).where(and(eq(labResults.id, id), eq(labResults.userId, userId)));
}
