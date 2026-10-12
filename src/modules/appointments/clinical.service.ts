import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { reviews, users } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { sendPush } from '../../integrations/push.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, forbidden, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { requireParticipant } from './appointments.service.js';

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
