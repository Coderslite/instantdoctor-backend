import { and, desc, eq, exists, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from '../../db/client.js';
import { appointmentMessages, appointments, payments, users } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { sendPush } from '../../integrations/push.js';
import { affectedRows } from '../../lib/db-errors.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { round2 } from '../../lib/money.js';
import { realtime } from '../../realtime/gateway.js';
import { settleAppointment } from '../doctor-payouts/doctor-payouts.ledger.js';
import { createNotification } from '../notifications/notifications.service.js';
import { credit, WALLET_CURRENCY } from '../wallet/wallet.ledger.js';
import { emailAppointmentUpdate } from './appointment-emails.js';

/**
 * Closing consultations after their time is up. A consultation the doctor
 * took part in (sent a chat message, or a call was answered) is completed
 * automatically, which pays the doctor. One with no sign the doctor took
 * part, or a paid booking no doctor accepted, is never paid out or refunded
 * automatically: it goes to an admin, who completes it or cancels and
 * refunds the patient.
 */

/** Grace after the scheduled end before closing, so running-over consultations aren't cut short. */
export const COMPLETION_GRACE_MS = 30 * 60_000;

export type CompletedBy = 'doctor' | 'auto' | 'admin';

/** Marks an active (or reviewed) consultation completed and credits the doctor. Idempotent. */
export async function completeAppointment(appointmentId: string, by: CompletedBy) {
  const done = await db.transaction(async (tx) => {
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (!a || a.status === 'completed' || a.status === 'cancelled' || a.status === 'deleted') return null;
    await tx
      .update(appointments)
      .set({ status: 'completed', completedAt: new Date(), completedBy: by, needsReviewAt: null, reviewReason: null })
      .where(eq(appointments.id, appointmentId));
    await settleAppointment(tx, appointmentId);
    return a;
  });
  if (!done) return false;
  realtime.toUser(done.userId, 'appointment:updated', { id: done.id, status: 'completed', isPaid: done.isPaid });
  if (done.doctorId)
    realtime.toUser(done.doctorId, 'appointment:updated', { id: done.id, status: 'completed', isPaid: done.isPaid });
  void emailAppointmentUpdate(appointmentId, 'completed');
  if (by !== 'doctor') {
    const [patient] = await db.select({ token: users.fcmToken }).from(users).where(eq(users.id, done.userId));
    void sendPush([patient?.token], {
      title: 'Consultation completed',
      body: 'Your consultation has ended. You can find any prescription in the app, and tell us how it went.',
      data: { type: 'appointment', id: done.id },
    }).catch((err: unknown) => logger.error({ err }, 'Completion push failed'));
  }
  return true;
}

const doctorSpoke = () =>
  exists(
    db
      .select({ id: appointmentMessages.id })
      .from(appointmentMessages)
      .where(and(eq(appointmentMessages.appointmentId, appointments.id), eq(appointmentMessages.senderId, appointments.doctorId))),
  );

/** At the scheduled end: remind the doctor to complete the consultation. */
export async function remindDoctorsToComplete(now = new Date()) {
  const due = await db
    .select({ id: appointments.id, doctorId: appointments.doctorId, patientFirstName: users.firstName })
    .from(appointments)
    .innerJoin(users, eq(users.id, appointments.userId))
    .where(
      and(
        eq(appointments.status, 'active'),
        lte(appointments.endTime, now),
        isNull(appointments.completionRemindedAt),
        isNotNull(appointments.doctorId),
      ),
    )
    .limit(200);
  if (!due.length) return 0;
  await db.update(appointments).set({ completionRemindedAt: now }).where(inArray(appointments.id, due.map((d) => d.id)));
  const doctors = await db
    .select({ id: users.id, token: users.fcmToken })
    .from(users)
    .where(inArray(users.id, [...new Set(due.map((d) => d.doctorId!))]));
  for (const d of due) {
    const token = doctors.find((x) => x.id === d.doctorId)?.token;
    void sendPush([token], {
      title: 'Consultation time is up',
      body: `Mark your consultation with ${d.patientFirstName || 'your patient'} as completed to get paid. It closes automatically in 30 minutes if you were active in it.`,
      data: { type: 'appointment', id: d.id },
    }).catch((err: unknown) => logger.error({ err }, 'Completion reminder push failed'));
  }
  return due.length;
}

/**
 * After the grace period: complete consultations the doctor took part in, and
 * send the rest (and paid bookings no doctor accepted) to admin review.
 */
export async function closeFinishedAppointments(now = new Date()) {
  const cutoff = new Date(now.getTime() - COMPLETION_GRACE_MS);
  const finished = await db
    .select({
      id: appointments.id,
      evidence: sql<number>`(${appointments.doctorJoinedAt} IS NOT NULL OR ${doctorSpoke()})`,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'active'),
        eq(appointments.isPaid, true),
        lte(appointments.endTime, cutoff),
        isNull(appointments.needsReviewAt),
      ),
    )
    .limit(200);
  let completed = 0;
  const review: string[] = [];
  for (const a of finished) {
    if (Number(a.evidence)) {
      if (await completeAppointment(a.id, 'auto')) completed += 1;
    } else review.push(a.id);
  }
  if (review.length)
    await db
      .update(appointments)
      .set({ needsReviewAt: now, reviewReason: 'no_activity' })
      .where(and(inArray(appointments.id, review), isNull(appointments.needsReviewAt)));
  const unaccepted = await db
    .update(appointments)
    .set({ needsReviewAt: now, reviewReason: 'not_accepted' })
    .where(
      and(
        eq(appointments.status, 'pending'),
        eq(appointments.isPaid, true),
        lte(appointments.endTime, now),
        isNull(appointments.needsReviewAt),
      ),
    );
  const notAccepted = affectedRows(unaccepted);
  if (review.length + notAccepted > 0)
    void mailer
      .opsAppointmentsReview({ count: review.length + notAccepted, noActivity: review.length, notAccepted })
      .catch((err: unknown) => logger.error({ err }, 'Review email failed'));
  return { completed, flagged: review.length + notAccepted };
}

/**
 * Once its start time arrives, an unpaid booking can no longer be paid for
 * (checkout refuses started slots), so it is cancelled. Paid ones no doctor
 * accepted are left to closeFinishedAppointments and admin review.
 */
export async function cancelUnpaidStartedAppointments(now = new Date()) {
  const due = await db
    .select({ id: appointments.id, userId: appointments.userId, doctorId: appointments.doctorId })
    .from(appointments)
    .where(and(eq(appointments.status, 'pending'), eq(appointments.isPaid, false), lte(appointments.startTime, now)))
    .limit(200);
  if (!due.length) return 0;
  const ids = due.map((a) => a.id);
  // isPaid is re-checked here so a payment confirmed in the meantime wins.
  await db
    .update(appointments)
    .set({ status: 'cancelled' })
    .where(and(inArray(appointments.id, ids), eq(appointments.status, 'pending'), eq(appointments.isPaid, false)));
  const cancelled = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(inArray(appointments.id, ids), eq(appointments.status, 'cancelled')));
  for (const { id } of cancelled) {
    const a = due.find((d) => d.id === id)!;
    realtime.toUser(a.userId, 'appointment:updated', { id, status: 'cancelled', isPaid: false });
    if (a.doctorId) realtime.toUser(a.doctorId, 'appointment:updated', { id, status: 'cancelled', isPaid: false });
  }
  return cancelled.length;
}

/* ───────────── admin review ───────────── */

const patient = alias(users, 'patient');
const doctor = alias(users, 'doctor');

export async function listForReview() {
  const rows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      reviewReason: appointments.reviewReason,
      needsReviewAt: appointments.needsReviewAt,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      packageLabel: appointments.packageLabel,
      price: appointments.price,
      currency: appointments.currency,
      isTrial: appointments.isTrial,
      hmoClaimId: appointments.hmoClaimId,
      isSubscriptionCredit: appointments.isSubscriptionCredit,
      doctorEarning: appointments.doctorEarning,
      patientJoinedAt: appointments.patientJoinedAt,
      doctorJoinedAt: appointments.doctorJoinedAt,
      patientName: sql<string>`TRIM(CONCAT(${patient.firstName}, ' ', ${patient.lastName}))`,
      patientEmail: patient.email,
      doctorName: sql<string | null>`TRIM(CONCAT(${doctor.firstName}, ' ', ${doctor.lastName}))`,
      messages: sql<number>`(SELECT COUNT(*) FROM appointment_messages m WHERE m.appointment_id = ${appointments.id})`,
      doctorMessages: sql<number>`(SELECT COUNT(*) FROM appointment_messages m WHERE m.appointment_id = ${appointments.id} AND m.sender_id = ${appointments.doctorId})`,
    })
    .from(appointments)
    .innerJoin(patient, eq(patient.id, appointments.userId))
    .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
    .where(and(isNotNull(appointments.needsReviewAt), inArray(appointments.status, ['active', 'pending'])))
    .orderBy(desc(appointments.needsReviewAt))
    .limit(200);
  const paid = rows.length
    ? await db
        .select({ ref: payments.purposeRefId, amount: payments.amount, currency: payments.currency, provider: payments.provider })
        .from(payments)
        .where(and(eq(payments.purpose, 'appointment'), eq(payments.status, 'succeeded'), inArray(payments.purposeRefId, rows.map((r) => r.id))))
    : [];
  return rows.map((r) => {
    const payment = paid.find((p) => p.ref === r.id) ?? null;
    return {
      ...r,
      messages: Number(r.messages),
      doctorMessages: Number(r.doctorMessages),
      payment,
      /** The wallet holds naira, so only naira payments can be refunded to it automatically. */
      walletRefundable: Boolean(payment && payment.currency === WALLET_CURRENCY),
    };
  });
}

/**
 * The admin's decision on a flagged consultation:
 * - complete: it happened; the doctor is paid.
 * - cancel: it didn't; the doctor is not paid and an HMO isn't billed. With
 *   `refund`, what the patient paid (in naira) goes back to their wallet.
 */
export async function resolveReview(appointmentId: string, input: { action: 'complete' } | { action: 'cancel'; refund: boolean }, adminName: string) {
  const [a] = await db.select().from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!a) throw notFound('Appointment');
  if (a.status !== 'active' && a.status !== 'pending') throw badRequest(`This consultation is already ${a.status}`);
  if (input.action === 'complete') {
    if (!a.doctorId) throw badRequest('No doctor took this consultation, so it can’t be completed. Cancel it instead.');
    await completeAppointment(appointmentId, 'admin');
    logger.info({ appointmentId, adminName }, 'Consultation completed on review');
    return { id: appointmentId, status: 'completed' as const };
  }
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'appointment'), eq(payments.purposeRefId, appointmentId), eq(payments.status, 'succeeded')))
    .orderBy(desc(payments.paidAt))
    .limit(1);
  if (input.refund && payment && payment.currency !== WALLET_CURRENCY)
    throw unprocessable('REFUND_NOT_IN_NAIRA', `This was paid in ${payment.currency}. Refund it through ${payment.provider}, then cancel without a wallet refund.`);
  const refund = input.refund && payment && !a.refundedAt ? round2(payment.amount) : 0;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (locked?.status !== 'active' && locked?.status !== 'pending') throw badRequest('This consultation changed; refresh and try again');
    await tx
      .update(appointments)
      .set({ status: 'cancelled', needsReviewAt: null, reviewReason: null, ...(refund > 0 ? { refundedAt: new Date(), refundedAmount: refund } : {}) })
      .where(eq(appointments.id, appointmentId));
    await settleAppointment(tx, appointmentId);
    if (refund > 0) {
      await credit(tx, { userId: a.userId, amount: refund, title: `Refund: ${a.packageLabel} consultation that didn’t take place`, paymentId: payment!.id });
      await createNotification(
        { userId: a.userId, type: 'transaction', title: `₦${refund.toLocaleString('en-NG')} refunded to your wallet for a consultation that didn’t take place` },
        tx,
      );
    }
  });
  realtime.toUser(a.userId, 'appointment:updated', { id: a.id, status: 'cancelled', isPaid: a.isPaid });
  if (a.doctorId) realtime.toUser(a.doctorId, 'appointment:updated', { id: a.id, status: 'cancelled', isPaid: a.isPaid });
  void emailAppointmentUpdate(appointmentId, 'cancelled');
  logger.info({ appointmentId, adminName, refund }, 'Consultation cancelled on review');
  return { id: appointmentId, status: 'cancelled' as const, refunded: refund };
}
