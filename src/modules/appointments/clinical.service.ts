import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { prescriptions, reviews, users } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { sendPush } from '../../integrations/push.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { requireParticipant } from './appointments.service.js';

export async function listPrescriptions(userId: string, appointmentId: string) {
  await requireParticipant(appointmentId, userId);
  return db
    .select()
    .from(prescriptions)
    .where(eq(prescriptions.appointmentId, appointmentId))
    .orderBy(desc(prescriptions.createdAt));
}

/** A prescription may only be issued by the assigned doctor after the visit. */
export async function createPrescription(
  doctorId: string,
  appointmentId: string,
  input: { prescription: string },
) {
  const appointment = await requireParticipant(appointmentId, doctorId);
  if (appointment.doctorId !== doctorId) throw forbidden('Only the assigned doctor can issue a prescription');
  if (appointment.status !== 'completed') {
    throw unprocessable('APPOINTMENT_NOT_COMPLETED', 'Complete the appointment before issuing a prescription');
  }

  const prescription = {
    id: newId(),
    appointmentId,
    userId: appointment.userId,
    doctorId,
    prescription: input.prescription,
    seen: false,
    createdAt: new Date(),
  };
  await db.insert(prescriptions).values(prescription);
  return prescription;
}

async function requireEditablePrescription(
  doctorId: string,
  appointmentId: string,
  prescriptionId: string,
) {
  const appointment = await requireParticipant(appointmentId, doctorId);
  if (appointment.doctorId !== doctorId) throw forbidden('Only the assigned doctor can change a prescription');
  if (appointment.status !== 'completed') {
    throw unprocessable('APPOINTMENT_NOT_COMPLETED', 'Complete the appointment before changing a prescription');
  }
  const [prescription] = await db
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.appointmentId, appointmentId)))
    .limit(1);
  if (!prescription || prescription.doctorId !== doctorId) throw notFound('Prescription');
  return prescription;
}

export async function updatePrescription(
  doctorId: string,
  appointmentId: string,
  prescriptionId: string,
  input: { prescription: string },
) {
  const existing = await requireEditablePrescription(doctorId, appointmentId, prescriptionId);
  await db.update(prescriptions).set({ prescription: input.prescription }).where(eq(prescriptions.id, prescriptionId));
  return { ...existing, prescription: input.prescription };
}

export async function deletePrescription(doctorId: string, appointmentId: string, prescriptionId: string) {
  await requireEditablePrescription(doctorId, appointmentId, prescriptionId);
  await db.delete(prescriptions).where(eq(prescriptions.id, prescriptionId));
}

export async function markPrescriptionSeen(userId: string, prescriptionId: string) {
  const [row] = await db.select().from(prescriptions).where(eq(prescriptions.id, prescriptionId)).limit(1);
  if (!row || row.userId !== userId) throw notFound('Prescription');
  await db.update(prescriptions).set({ seen: true }).where(eq(prescriptions.id, prescriptionId));
}

export async function getReview(userId: string, appointmentId: string) {
  await requireParticipant(appointmentId, userId);
  const [review] = await db.select().from(reviews).where(eq(reviews.appointmentId, appointmentId)).limit(1);
  return review ?? null;
}

export async function addReview(userId: string, appointmentId: string, input: { rating: number; review: string }) {
  const appointment = await requireParticipant(appointmentId, userId);
  if (appointment.userId !== userId) throw forbidden('Only the patient can review this appointment');
  if (!appointment.isPaid) throw unprocessable('NOT_PAID', 'Only paid appointments can be reviewed');
  const doctorId = appointment.doctorId;
  if (!doctorId) throw unprocessable('NOT_ASSIGNED', 'No doctor has accepted this appointment yet');

  const review = {
    id: newId(),
    appointmentId,
    userId,
    doctorId,
    rating: input.rating,
    review: input.review,
    createdAt: new Date(),
  };
  try {
    await db.insert(reviews).values(review);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('ALREADY_REVIEWED', 'You have already reviewed this appointment');
    throw err;
  }

  const [[doctor], [patient]] = await Promise.all([
    db.select({ token: users.fcmToken }).from(users).where(eq(users.id, doctorId)),
    db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, userId)),
  ]);
  void sendPush([doctor?.token], {
    title: 'Appointment Review',
    body: `You got a ${input.rating} star rating from ${patient?.firstName ?? ''} ${patient?.lastName ?? ''}`.trim(),
  });
  void mailer.activity(userId, 'Doctor Review');
  return review;
}
