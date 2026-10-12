import { and, desc, eq, gt, inArray, ne, or, sql, sum } from 'drizzle-orm';
import type { z } from 'zod';
import { db, type Executor, type Tx } from '../../db/client.js';
import {
  appointments,
  orderItems,
  orders,
  prescriptionItems,
  prescriptions,
  users,
} from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { requireParticipant } from '../appointments/appointments.service.js';
import { matchScore } from './prescription-matching.js';
import type { prescriptionSchema } from './prescriptions.schemas.js';

/**
 * E-prescriptions. A doctor prescribes medicines as structured items after a
 * consultation; each prescription gets a short code a pharmacist can verify
 * and is valid for a fixed time. Pharmacy order lines link to the item they
 * dispense, so a prescription can never be dispensed beyond what was
 * prescribed — and an HMO only pays for medicines dispensed this way.
 */

export const PRESCRIPTION_VALID_DAYS = 30;
/** How long an unpaid order keeps prescribed quantity reserved. */
const UNPAID_HOLD_MS = 60 * 60_000;

type PrescriptionRow = typeof prescriptions.$inferSelect;
type ItemRow = typeof prescriptionItems.$inferSelect;
export type PrescriptionInput = z.infer<typeof prescriptionSchema>;

/** Readable text of the whole prescription, kept for older apps and printing. */
export function prescriptionText(
  items: Array<Pick<ItemRow, 'name' | 'strength' | 'form' | 'directions' | 'durationDays' | 'quantity'>>,
  notes: string | null,
) {
  const lines = items.map((i, n) =>
    [
      `${n + 1}. ${i.name}${i.strength ? ` ${i.strength}` : ''}${i.form ? ` (${i.form})` : ''}`,
      `   ${i.directions}${i.durationDays ? ` for ${i.durationDays} day${i.durationDays === 1 ? '' : 's'}` : ''}`,
      `   Quantity: ${i.quantity}`,
    ].join('\n'),
  );
  return [lines.join('\n'), notes?.trim()].filter(Boolean).join('\n\n');
}

/**
 * Units dispensed (or reserved by an order still awaiting payment) per
 * prescription item. Cancelled orders give their quantity back.
 */
export async function dispensedQuantities(itemIds: string[], executor: Executor = db) {
  const out = new Map<string, number>();
  if (!itemIds.length) return out;
  const rows = await executor
    .select({ itemId: orderItems.prescriptionItemId, quantity: sum(orderItems.quantity).mapWith(Number) })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        inArray(orderItems.prescriptionItemId, itemIds),
        ne(orders.status, 'cancelled'),
        or(ne(orders.status, 'awaiting_payment'), gt(orders.createdAt, new Date(Date.now() - UNPAID_HOLD_MS))),
      ),
    )
    .groupBy(orderItems.prescriptionItemId);
  for (const r of rows) if (r.itemId) out.set(r.itemId, r.quantity ?? 0);
  return out;
}

const isExpired = (p: Pick<PrescriptionRow, 'expiresAt'>, now = new Date()) =>
  p.expiresAt !== null && p.expiresAt <= now;

/** Prescriptions with their items, what is left to dispense and the prescriber's name. */
export async function withItems(rows: PrescriptionRow[], executor: Executor = db) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [items, doctors] = await Promise.all([
    executor
      .select()
      .from(prescriptionItems)
      .where(inArray(prescriptionItems.prescriptionId, ids))
      .orderBy(prescriptionItems.sortOrder),
    executor
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.doctorId))])),
  ]);
  const dispensed = await dispensedQuantities(items.map((i) => i.id), executor);
  const doctorName = new Map(doctors.map((d) => [d.id, `Dr ${`${d.firstName} ${d.lastName}`.trim()}`]));
  const now = new Date();
  return rows.map((p) => {
    const own = items
      .filter((i) => i.prescriptionId === p.id)
      .map((i) => {
        const used = dispensed.get(i.id) ?? 0;
        return {
          id: i.id,
          name: i.name,
          strength: i.strength,
          form: i.form,
          directions: i.directions,
          durationDays: i.durationDays,
          quantity: i.quantity,
          dispensed: used,
          remaining: Math.max(0, i.quantity - used),
        };
      });
    const expired = isExpired(p, now);
    return {
      ...p,
      doctorName: doctorName.get(p.doctorId) ?? null,
      items: own,
      isExpired: expired,
      /** Medicines can still be ordered against it. */
      canOrder: Boolean(p.code) && !expired && own.some((i) => i.remaining > 0),
    };
  });
}

export type PrescriptionView = Awaited<ReturnType<typeof withItems>>[number];

// ─── Doctor: issue, correct, withdraw ────────────────────────────────────────

async function requireDoctorOnAcceptedVisit(doctorId: string, appointmentId: string, verb: string) {
  const appointment = await requireParticipant(appointmentId, doctorId);
  if (appointment.doctorId !== doctorId) throw forbidden(`Only the assigned doctor can ${verb} a prescription`);
  if (appointment.status !== 'active' && appointment.status !== 'completed') {
    throw unprocessable('APPOINTMENT_NOT_ACCEPTED', `Accept the appointment before you ${verb} a prescription`);
  }
  return appointment;
}

const itemRows = (prescriptionId: string, input: PrescriptionInput) =>
  (input.items ?? []).map((i, n) => ({
    id: newId(),
    prescriptionId,
    name: i.name,
    strength: i.strength ?? null,
    form: i.form ?? null,
    directions: i.directions,
    durationDays: i.durationDays ?? null,
    quantity: i.quantity,
    sortOrder: n,
  }));

/** New clients send `items` (+ `notes`); older ones send the whole prescription as `prescription` text. */
const notesOf = (input: PrescriptionInput) =>
  (input.notes ?? (input.items?.length ? input.prescription : null))?.trim() || null;

export async function createPrescription(doctorId: string, appointmentId: string, input: PrescriptionInput) {
  const appointment = await requireDoctorOnAcceptedVisit(doctorId, appointmentId, 'issue');
  const id = newId();
  const items = itemRows(id, input);
  const notes = notesOf(input);
  const createdAt = new Date();
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(prescriptions).values({
          id,
          appointmentId,
          userId: appointment.userId,
          doctorId,
          prescription: items.length ? prescriptionText(items, notes) : (input.prescription ?? notes ?? '').trim(),
          notes: items.length ? notes : null,
          code: `RX-${randomCode(6)}`,
          expiresAt: new Date(createdAt.getTime() + PRESCRIPTION_VALID_DAYS * 24 * 3600_000),
          seen: false,
          createdAt,
        });
        if (items.length) await tx.insert(prescriptionItems).values(items);
      });
      break;
    } catch (err) {
      // A code collision is astronomically rare; try a fresh one.
      if (isDuplicateKeyError(err) && attempt < 3) continue;
      throw err;
    }
  }
  return (await getPrescription(id))!;
}

async function requireEditable(doctorId: string, appointmentId: string, prescriptionId: string, verb: string) {
  await requireDoctorOnAcceptedVisit(doctorId, appointmentId, verb);
  const [row] = await db
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.appointmentId, appointmentId)))
    .limit(1);
  if (!row || row.doctorId !== doctorId) throw notFound('Prescription');
  return row;
}

async function assertNotDispensed(tx: Tx | typeof db, prescriptionId: string, verb: string) {
  const items = await tx
    .select({ id: prescriptionItems.id })
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, prescriptionId));
  const dispensed = await dispensedQuantities(items.map((i) => i.id), tx);
  if ([...dispensed.values()].some((q) => q > 0))
    throw conflict(
      'PRESCRIPTION_DISPENSED',
      `Medicines on this prescription have already been ordered from a pharmacy, so it can’t be ${verb}. Issue a new prescription instead.`,
    );
}

export async function updatePrescription(
  doctorId: string,
  appointmentId: string,
  prescriptionId: string,
  input: PrescriptionInput,
) {
  const existing = await requireEditable(doctorId, appointmentId, prescriptionId, 'change');
  const notes = notesOf(input);
  await db.transaction(async (tx) => {
    await tx.select({ id: prescriptions.id }).from(prescriptions).where(eq(prescriptions.id, prescriptionId)).for('update');
    if (input.items) {
      // Items are replaced whole, which would orphan what a pharmacy already dispensed.
      await assertNotDispensed(tx, prescriptionId, 'changed');
      const items = itemRows(prescriptionId, input);
      await tx.delete(prescriptionItems).where(eq(prescriptionItems.prescriptionId, prescriptionId));
      if (items.length) await tx.insert(prescriptionItems).values(items);
      await tx
        .update(prescriptions)
        .set({
          prescription: items.length ? prescriptionText(items, notes) : (notes ?? ''),
          notes: items.length ? notes : null,
          code: existing.code ?? `RX-${randomCode(6)}`,
        })
        .where(eq(prescriptions.id, prescriptionId));
    } else {
      // Legacy clients edit the text only; structured items (if any) stay.
      const items = await tx
        .select()
        .from(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, prescriptionId))
        .orderBy(prescriptionItems.sortOrder);
      const text = (input.prescription ?? input.notes ?? '').trim();
      await tx
        .update(prescriptions)
        .set(items.length ? { notes: text || null, prescription: prescriptionText(items, text) } : { prescription: text })
        .where(eq(prescriptions.id, prescriptionId));
    }
  });
  return (await getPrescription(prescriptionId))!;
}

export async function deletePrescription(doctorId: string, appointmentId: string, prescriptionId: string) {
  await requireEditable(doctorId, appointmentId, prescriptionId, 'delete');
  await db.transaction(async (tx) => {
    await assertNotDispensed(tx, prescriptionId, 'deleted');
    await tx.delete(prescriptions).where(eq(prescriptions.id, prescriptionId));
  });
}

// ─── Reading ─────────────────────────────────────────────────────────────────

async function getPrescription(id: string) {
  const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
  return row ? (await withItems([row]))[0]! : null;
}

/** For the patient or doctor of one consultation. */
export async function listForAppointment(userId: string, appointmentId: string) {
  await requireParticipant(appointmentId, userId);
  const rows = await db
    .select()
    .from(prescriptions)
    .where(eq(prescriptions.appointmentId, appointmentId))
    .orderBy(desc(prescriptions.createdAt));
  return withItems(rows);
}

/** Every prescription a patient has received, newest first. */
export async function listForPatient(userId: string, query: { limit: number; offset: number }) {
  const rows = await db
    .select({ p: prescriptions, appointmentDate: appointments.startTime })
    .from(prescriptions)
    .innerJoin(appointments, eq(appointments.id, prescriptions.appointmentId))
    .where(and(eq(prescriptions.userId, userId), ne(appointments.status, 'deleted')))
    .orderBy(desc(prescriptions.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const views = await withItems(rows.map((r) => r.p));
  return views.map((v, i) => ({ ...v, appointmentDate: rows[i]!.appointmentDate }));
}

export async function getForPatient(userId: string, id: string) {
  const p = await getPrescription(id);
  if (!p || p.userId !== userId) throw notFound('Prescription');
  return p;
}

export async function markSeen(userId: string, id: string) {
  const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
  if (!row || row.userId !== userId) throw notFound('Prescription');
  await db.update(prescriptions).set({ seen: true }).where(eq(prescriptions.id, id));
}

/**
 * What a pharmacist sees when checking a code a patient shows them: who
 * prescribed what, whether it is still valid and how much is left. The
 * patient is identified by first name and surname initial only.
 */
export async function verifyCode(code: string) {
  const normalised = code.trim().toUpperCase().replace(/^RX-?/, 'RX-');
  const [row] = await db.select().from(prescriptions).where(eq(prescriptions.code, normalised)).limit(1);
  if (!row) throw notFound('Prescription');
  const [view] = await withItems([row]);
  const [patient] = await db
    .select({ firstName: users.firstName, lastName: users.lastName, dateOfBirth: users.dateOfBirth })
    .from(users)
    .where(eq(users.id, row.userId));
  return {
    code: view!.code,
    issuedAt: view!.createdAt,
    expiresAt: view!.expiresAt,
    isExpired: view!.isExpired,
    doctorName: view!.doctorName,
    patient: {
      name: `${patient?.firstName ?? ''} ${(patient?.lastName ?? '').slice(0, 1)}${patient?.lastName ? '.' : ''}`.trim(),
      dateOfBirth: patient?.dateOfBirth ?? null,
    },
    notes: view!.notes ?? (view!.items.length ? null : view!.prescription),
    items: view!.items,
  };
}

// ─── Dispensing against a prescription (used by checkout) ────────────────────

export interface PrescribedLine {
  prescriptionItemId: string;
  productName: string;
  quantity: number;
}

/**
 * Checks cart lines that claim to dispense a prescription: the item is the
 * patient's, the prescription is current, the product is that medicine and
 * the quantity is still available. Pass a transaction to lock the
 * prescriptions while an order is being created.
 */
export async function checkPrescribedLines(userId: string, lines: PrescribedLine[], tx?: Tx) {
  if (!lines.length) return new Map<string, ItemRow & { prescription: PrescriptionRow }>();
  const executor = tx ?? db;
  const ids = [...new Set(lines.map((l) => l.prescriptionItemId))];
  const query = executor
    .select({ item: prescriptionItems, prescription: prescriptions })
    .from(prescriptionItems)
    .innerJoin(prescriptions, eq(prescriptions.id, prescriptionItems.prescriptionId))
    .where(inArray(prescriptionItems.id, ids));
  // Inside checkout, lock the prescriptions so two orders can't both take the last units.
  const rows = tx ? await query.for('update') : await query;
  const byId = new Map(rows.map((r) => [r.item.id, { ...r.item, prescription: r.prescription }]));
  const dispensed = await dispensedQuantities(ids, executor);
  for (const line of lines) {
    const item = byId.get(line.prescriptionItemId);
    if (!item || item.prescription.userId !== userId) throw notFound('Prescription item');
    if (!item.prescription.code || isExpired(item.prescription))
      throw unprocessable('PRESCRIPTION_EXPIRED', `Your prescription for ${item.name} has expired. Ask your doctor for a new one.`);
    if (matchScore(item, line.productName) === null)
      throw unprocessable(
        'PRESCRIPTION_MISMATCH',
        `“${line.productName}” isn’t the ${item.name}${item.strength ? ` ${item.strength}` : ''} on your prescription.`,
        { prescriptionItemId: item.id },
      );
    const left = item.quantity - (dispensed.get(item.id) ?? 0);
    if (line.quantity > left)
      throw unprocessable(
        'PRESCRIPTION_QUANTITY_EXCEEDED',
        left > 0
          ? `Your prescription allows ${left} more of ${item.name}.`
          : `You have already ordered all the ${item.name} on your prescription.`,
        { prescriptionItemId: item.id, available: Math.max(0, left) },
      );
  }
  return byId;
}

/** Prescription details for the pharmacy handling an order. */
export async function prescriptionsForOrder(orderId: string) {
  const rows = await db
    .select({ itemId: orderItems.prescriptionItemId })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), sql`${orderItems.prescriptionItemId} IS NOT NULL`));
  if (!rows.length) return [];
  const items = await db
    .select({ prescriptionId: prescriptionItems.prescriptionId })
    .from(prescriptionItems)
    .where(inArray(prescriptionItems.id, rows.map((r) => r.itemId!)));
  const ids = [...new Set(items.map((i) => i.prescriptionId))];
  if (!ids.length) return [];
  const prescriptionRows = await db.select().from(prescriptions).where(inArray(prescriptions.id, ids));
  return (await withItems(prescriptionRows)).map((p) => ({
    id: p.id,
    code: p.code,
    doctorName: p.doctorName,
    issuedAt: p.createdAt,
    expiresAt: p.expiresAt,
    notes: p.notes,
    items: p.items,
  }));
}
