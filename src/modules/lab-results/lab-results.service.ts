import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { labResultFiles, labResults, serviceCharges, users } from '../../db/schema/index.js';
import { notFound, serviceUnavailable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { quoteFromUsd, resolveRegion } from '../pricing/pricing.service.js';

/** Firestore `Charges` type for lab interpretation (legacy spelling preserved). */
export const LAB_CHARGE_TYPE = 'LapResult';

export async function quoteForUser(userId: string) {
  const [[charge], [user]] = await Promise.all([
    db.select().from(serviceCharges).where(eq(serviceCharges.type, LAB_CHARGE_TYPE)).limit(1),
    db.select({ country: users.country, currency: users.currency }).from(users).where(eq(users.id, userId)),
  ]);
  if (!charge) throw serviceUnavailable('Lab result pricing is not configured');
  if (!user) throw notFound('User');
  return quoteFromUsd(charge.amountUsd, resolveRegion(user));
}

async function withFiles(rows: Array<typeof labResults.$inferSelect>) {
  if (rows.length === 0) return [];
  const files = await db.select().from(labResultFiles).where(inArray(labResultFiles.labResultId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    ...r,
    files: files.filter((f) => f.labResultId === r.id).map((f) => ({ fileUrl: f.fileUrl, fileType: f.fileType })),
  }));
}

/**
 * Submits files for interpretation with a server-side quote. Paid results start
 * `awaiting_payment`; pay with POST /payments { purpose: "lab_result" }.
 */
export async function createLabResult(userId: string, files: Array<{ fileUrl: string; fileType: string }>) {
  const quote = await quoteForUser(userId);
  const id = newId();
  await db.transaction(async (tx) => {
    await tx.insert(labResults).values({
      id,
      userId,
      status: quote.amount > 0 ? 'awaiting_payment' : 'pending',
      price: quote.amount,
      currency: quote.currency,
    });
    await tx.insert(labResultFiles).values(files.map((f) => ({ id: newId(), labResultId: id, ...f })));
  });
  const [row] = await db.select().from(labResults).where(eq(labResults.id, id));
  return (await withFiles([row!]))[0]!;
}

export async function listLabResults(userId: string) {
  const rows = await db.select().from(labResults).where(eq(labResults.userId, userId)).orderBy(desc(labResults.createdAt));
  return withFiles(rows);
}

export async function markOpened(userId: string, id: string) {
  await db.update(labResults).set({ opened: true }).where(and(eq(labResults.id, id), eq(labResults.userId, userId)));
}

export async function deleteLabResult(userId: string, id: string) {
  await db.delete(labResults).where(and(eq(labResults.id, id), eq(labResults.userId, userId)));
}
