import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { medicationDoses, medications } from '../../db/schema/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { mailer } from '../../integrations/mailer.js';
import { resolveProfileId } from '../family/family.service.js';
import type { doseSchema, medicationSchema, updateMedicationSchema } from './medications.schemas.js';

type Medication = typeof medications.$inferSelect;
type Dose = typeof medicationDoses.$inferSelect;
type ClockTime = { hour: number; minute: number };

const toSqlTime = (hhmm: string | null | undefined) => (hhmm ? `${hhmm}:00` : hhmm);
const toHhmm = (sqlTime: string | null) => (sqlTime ? sqlTime.slice(0, 5) : null);
const toClock = (sqlTime: string): ClockTime => ({
  hour: Number(sqlTime.slice(0, 2)),
  minute: Number(sqlTime.slice(3, 5)),
});

/**
 * Includes the derived legacy fields (`takenDates`, `dailyTakenTimes`, ...)
 * so the mobile tracker UI can be ported without reshaping its logic.
 */
function serialize(m: Medication, doses: Dose[]) {
  const daily = (status: 'taken' | 'missed') => {
    const map: Record<string, ClockTime[]> = {};
    for (const d of doses) {
      if (d.status !== status) continue;
      (map[d.doseDate] ??= []);
      if (d.doseTime) map[d.doseDate]!.push(toClock(d.doseTime));
    }
    return map;
  };
  const dailyTakenTimes = daily('taken');
  const dailyMissedTimes = daily('missed');
  return {
    id: m.id,
    profileId: m.profileId,
    name: m.name,
    prescription: m.prescription,
    startTime: m.startTime,
    endTime: m.endTime,
    morningTime: toHhmm(m.morningTime),
    middayTime: toHhmm(m.middayTime),
    eveningTime: toHhmm(m.eveningTime),
    intervalHours: m.intervalHours,
    doses: doses.map((d) => ({ date: d.doseDate, time: toHhmm(d.doseTime), status: d.status })),
    takenDates: Object.keys(dailyTakenTimes).sort(),
    missedDates: Object.keys(dailyMissedTimes).sort(),
    dailyTakenTimes,
    dailyMissedTimes,
    createdAt: m.createdAt,
  };
}

async function requireOwned(userId: string, id: string) {
  const [row] = await db.select().from(medications).where(and(eq(medications.id, id), eq(medications.userId, userId))).limit(1);
  if (!row) throw notFound('Medication');
  return row;
}

/** Medications for one person: a family profile, or the account owner when [profileId] is null. */
export async function listMedications(userId: string, profileId: string | null = null) {
  const rows = await db
    .select()
    .from(medications)
    .where(and(eq(medications.userId, userId), profileId ? eq(medications.profileId, profileId) : isNull(medications.profileId)))
    .orderBy(medications.startTime);
  if (rows.length === 0) return [];
  const doses = await db.select().from(medicationDoses).where(inArray(medicationDoses.medicationId, rows.map((r) => r.id)));
  return rows.map((m) => serialize(m, doses.filter((d) => d.medicationId === m.id)));
}

export async function getMedication(userId: string, id: string) {
  const row = await requireOwned(userId, id);
  const doses = await db.select().from(medicationDoses).where(eq(medicationDoses.medicationId, id));
  return serialize(row, doses);
}

export async function createMedication(userId: string, input: z.infer<typeof medicationSchema>) {
  const profileId = await resolveProfileId(userId, input.profileId);
  const id = newId();
  await db.insert(medications).values({
    id,
    userId,
    ...input,
    profileId,
    morningTime: toSqlTime(input.morningTime),
    middayTime: toSqlTime(input.middayTime),
    eveningTime: toSqlTime(input.eveningTime),
  });
  void mailer.activity(userId, 'Medication Tracker');
  return getMedication(userId, id);
}

export async function updateMedication(userId: string, id: string, input: z.infer<typeof updateMedicationSchema>) {
  const current = await requireOwned(userId, id);
  const start = input.startTime ?? current.startTime;
  const end = input.endTime ?? current.endTime;
  if (end <= start) throw badRequest('endTime must be after startTime');
  await db
    .update(medications)
    .set({
      ...input,
      ...(input.morningTime !== undefined && { morningTime: toSqlTime(input.morningTime) }),
      ...(input.middayTime !== undefined && { middayTime: toSqlTime(input.middayTime) }),
      ...(input.eveningTime !== undefined && { eveningTime: toSqlTime(input.eveningTime) }),
    })
    .where(eq(medications.id, id));
  return getMedication(userId, id);
}

export async function deleteMedication(userId: string, id: string) {
  await requireOwned(userId, id);
  await db.delete(medications).where(eq(medications.id, id));
}

/** Marks one scheduled dose as taken or missed (upsert; taken overrides missed and vice versa). */
export async function recordDose(userId: string, id: string, input: z.infer<typeof doseSchema>) {
  await requireOwned(userId, id);
  await db
    .insert(medicationDoses)
    .values({ id: newId(), medicationId: id, doseDate: input.date, doseTime: toSqlTime(input.time)!, status: input.status })
    .onDuplicateKeyUpdate({ set: { status: input.status } });
  return getMedication(userId, id);
}
