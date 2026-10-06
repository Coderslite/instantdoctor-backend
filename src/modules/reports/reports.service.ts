import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { reportMessages, reports } from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { requireParticipant } from '../appointments/appointments.service.js';
import { attachFile, resolveFileUrl, withResolvedUrls } from '../files/files.service.js';

/** Support conversations are with this pseudo-participant. */
export const SUPPORT_ID = 'admin';

export async function createReport(userId: string, input: { appointmentId: string; subject: string; report: string }) {
  const appointment = await requireParticipant(input.appointmentId, userId);
  if (appointment.userId !== userId) throw forbidden('Only the patient can report an appointment');
  const id = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(reports).values({ id, userId, doctorId: appointment.doctorId, ...input });
      await tx.insert(reportMessages).values({ id: newId(), reportId: id, senderId: userId, receiverId: SUPPORT_ID, message: input.report });
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('ALREADY_REPORTED', 'This appointment has already been reported');
    throw err;
  }
  return getReport(userId, id);
}

async function getReport(userId: string, id: string) {
  const [row] = await db.select().from(reports).where(and(eq(reports.id, id), eq(reports.userId, userId))).limit(1);
  if (!row) throw notFound('Report');
  return row;
}

export const listReports = (userId: string) =>
  db.select().from(reports).where(eq(reports.userId, userId)).orderBy(desc(reports.updatedAt));

export async function getReportForAppointment(userId: string, appointmentId: string) {
  const [row] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.appointmentId, appointmentId), eq(reports.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function listMessages(userId: string, reportId: string) {
  await getReport(userId, reportId);
  const rows = await db
    .select()
    .from(reportMessages)
    .where(eq(reportMessages.reportId, reportId))
    .orderBy(desc(reportMessages.createdAt));
  return withResolvedUrls(rows, 'fileUrl');
}

export async function sendMessage(
  userId: string,
  reportId: string,
  input: { message: string; fileUrl?: string; fileId?: string; type: 'text' | 'image' | 'file' | 'voice' },
) {
  await getReport(userId, reportId);
  const row = {
    id: newId(),
    reportId,
    senderId: userId,
    receiverId: SUPPORT_ID,
    type: input.type,
    message: input.message,
    fileUrl: input.fileId
      ? await attachFile({ kind: 'patient', id: userId }, input.fileId, ['report_attachment'])
      : (input.fileUrl ?? null),
    status: 'delivered' as const,
    createdAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.insert(reportMessages).values(row);
    await tx.update(reports).set({ updatedAt: new Date() }).where(eq(reports.id, reportId));
  });
  return { ...row, fileUrl: await resolveFileUrl(row.fileUrl) };
}

export async function deleteReport(userId: string, reportId: string) {
  await getReport(userId, reportId);
  await db.delete(reports).where(eq(reports.id, reportId));
}
