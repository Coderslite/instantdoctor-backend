import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { env } from '../../config/env.js';
import { db, type Tx } from '../../db/client.js';
import {
  appointmentPackages,
  appointments,
  doctorProfiles,
  users,
  type AppointmentStatus,
} from '../../db/schema/index.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { UserRole } from '../../db/schema/users.js';
import { realtime } from '../../realtime/gateway.js';
import { emailAppointmentUpdate } from './appointment-emails.js';
import { runEffects, type Effect } from '../payments/effects.js';
import { confirmAppointment } from '../payments/fulfillment.js';
import { AFRICAN_COUNTRIES, quoteFromUsd, resolveRegion } from '../pricing/pricing.service.js';
import { getAppSettings, getTrialDoctorId } from '../settings/settings.service.js';
import { serializeUserSummary } from '../users/users.serializer.js';
import { familyCreditDoctorEarning, requireAvailableFamilyCredit } from '../subscriptions/subscriptions.service.js';
import type { CreateAppointmentInput } from './appointments.schemas.js';

const TRIAL_DURATION_SECONDS = 30 * 60;
/** Statuses that occupy a doctor's calendar. */
const BLOCKING_STATUSES: AppointmentStatus[] = ['pending', 'active'];

type AppointmentRow = typeof appointments.$inferSelect;

// ─── Packages & quotes ───────────────────────────────────────────────────────

/** Active packages priced for the caller's region. */
export async function listPackagesForUser(userId: string) {
  const [user] = await db.select({ country: users.country, currency: users.currency }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound('User');
  const region = resolveRegion(user);
  const packages = await db
    .select()
    .from(appointmentPackages)
    .where(eq(appointmentPackages.isActive, true))
    .orderBy(appointmentPackages.amountUsd);
  return Promise.all(
    packages.map(async (p) => {
      const quote = await quoteFromUsd(p.amountUsd, region);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        description: p.description,
        durationSeconds: p.durationSeconds,
        price: { amount: quote.amount, currency: quote.currency, amountUsd: quote.amountUsd },
      };
    }),
  );
}

// ─── Booking ─────────────────────────────────────────────────────────────────

interface BookingPlan {
  /** Null = open request, broadcast to doctors and claimed via `acceptAppointment`. */
  doctorId: string | null;
  packageId: string | null;
  packageLabel: string;
  packageType: AppointmentRow['packageType'];
  durationSeconds: number;
  price: number;
  currency: string | null;
  priceUsd: number | null;
  useFamilyCredit: boolean;
  subscriptionCreditEarning: number | null;
}

async function planBooking(userId: string, input: CreateAppointmentInput): Promise<BookingPlan> {
  if (input.isTrial) {
    const settings = await getAppSettings();
    if (!settings.trial) throw unprocessable('TRIAL_DISABLED', 'Free trial consultations are not available');
    return {
      doctorId: await getTrialDoctorId(),
      packageId: null,
      packageLabel: 'Trial Consultation',
      packageType: null,
      durationSeconds: TRIAL_DURATION_SECONDS,
      price: 0,
      currency: null,
      priceUsd: 0,
      useFamilyCredit: false,
      subscriptionCreditEarning: null,
    };
  }

  const [pkg] = await db
    .select()
    .from(appointmentPackages)
    .where(and(eq(appointmentPackages.id, input.packageId!), eq(appointmentPackages.isActive, true)))
    .limit(1);
  if (!pkg) throw badRequest('Unknown or inactive package', [{ path: 'packageId', message: 'not found' }]);

  if (input.useFamilyCredit && pkg.type !== 'basic') {
    throw badRequest('Family Care credits cover virtual GP consultations only', [{ path: 'packageId', message: 'select a GP package' }]);
  }
  const doctorId = input.doctorId ?? null;
  if (doctorId) {
    const [doctor] = await db
      .select({ available: doctorProfiles.isAvailable })
      .from(users)
      .innerJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
      .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!doctor) throw badRequest('Unknown doctor', [{ path: 'doctorId', message: 'not found' }]);
    if (!doctor.available) throw unprocessable('DOCTOR_UNAVAILABLE', 'This doctor is not taking appointments');
  }

  const [user] = await db.select({ country: users.country, currency: users.currency }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound('User');
  // Price is always computed server-side; the client never supplies an amount.
  const quote = await quoteFromUsd(pkg.amountUsd, resolveRegion(user));
  const african = AFRICAN_COUNTRIES.has(user.country?.toUpperCase() ?? '');

  return {
    doctorId,
    packageId: pkg.id,
    packageLabel: pkg.name,
    packageType: pkg.type,
    durationSeconds: pkg.durationSeconds,
    price: input.useFamilyCredit ? 0 : quote.amount,
    currency: input.useFamilyCredit ? (african ? 'NGN' : 'USD') : quote.currency,
    priceUsd: input.useFamilyCredit ? 0 : quote.amountUsd,
    useFamilyCredit: input.useFamilyCredit,
    subscriptionCreditEarning: input.useFamilyCredit ? familyCreditDoctorEarning(african) : null,
  };
}

/**
 * Books an appointment, either with a chosen doctor or as an open request
 * (no `doctorId`) that doctors accept later — the app's default flow.
 *
 * Concurrency & idempotency guarantees:
 * - For a chosen doctor, the doctor row is locked (SELECT ... FOR UPDATE) so
 *   concurrent bookings are serialised and the overlap check is race-free.
 * - Unpaid bookings hold the slot for BOOKING_HOLD_MINUTES (extended when payment
 *   starts), after which they no longer block other patients.
 * - Trial consumption is an atomic conditional update (one trial per user).
 * - `idempotencyKey` is stored under UNIQUE(user_id, idempotency_key): replays
 *   return the original appointment instead of booking twice.
 */
export async function createAppointment(
  userId: string,
  input: CreateAppointmentInput,
  idempotencyKey?: string,
  timeZone?: string | null,
) {
  if (idempotencyKey) {
    const existing = await findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { appointment: existing, created: false };
  }

  const minStart = Date.now() + env.BOOKING_MIN_LEAD_MINUTES * 60_000;
  if (input.startTime.getTime() < minStart) {
    throw badRequest(`Appointments must start at least ${env.BOOKING_MIN_LEAD_MINUTES} minutes from now`);
  }

  const plan = await planBooking(userId, input);
  if (plan.doctorId === userId) throw badRequest('You cannot book an appointment with yourself');

  const startTime = input.startTime;
  const endTime = new Date(startTime.getTime() + plan.durationSeconds * 1000);
  const appointmentId = newId();
  let effects: Effect[] = [];

  try {
    effects = await db.transaction(async (tx) => {
      if (plan.doctorId) {
        await lockDoctor(tx, plan.doctorId);
        await assertSlotFree(tx, plan.doctorId, startTime, endTime);
      }

      if (input.isTrial) {
        const consumed = await tx
          .update(users)
          .set({ isTrialAvailable: false })
          .where(and(eq(users.id, userId), eq(users.isTrialAvailable, true)));
        if (affectedRows(consumed) === 0) {
          throw conflict('TRIAL_UNAVAILABLE', 'Your free trial has already been used');
        }
      }

      const subscription = plan.useFamilyCredit
          ? await requireAvailableFamilyCredit(tx, userId)
          : null;

      await tx.insert(appointments).values({
        id: appointmentId,
        userId,
        doctorId: plan.doctorId,
        complaint: input.complaint,
        symptoms: input.symptoms,
        status: 'pending',
        packageId: plan.packageId,
        packageLabel: plan.packageLabel,
        packageType: plan.packageType,
        startTime,
        endTime,
        price: plan.price,
        currency: plan.currency,
        priceUsd: plan.priceUsd,
        isTrial: input.isTrial,
        isSubscriptionCredit: plan.useFamilyCredit,
        subscriptionId: subscription?.id ?? null,
        doctorEarning: plan.subscriptionCreditEarning,
        holdExpiresAt: holdUntil(),
        idempotencyKey: idempotencyKey ?? null,
        timeZone: validTimeZone(timeZone),
      });

      // Trials need no payment: confirm immediately with the same side effects as a paid booking.
      return input.isTrial || plan.useFamilyCredit ? (await confirmAppointment(tx, appointmentId)).effects : [];
    });
  } catch (err) {
    // A concurrent request with the same key won the race: return its result.
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) return { appointment: existing, created: false };
    }
    throw err;
  }

  await runEffects(effects);
  return { appointment: await getAppointmentForUser({ userId, role: 'user' }, appointmentId), created: true };
}

export function validTimeZone(value: string | null | undefined): string | null {
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const holdUntil = () => new Date(Date.now() + env.BOOKING_HOLD_MINUTES * 60_000);

/** Serialises all calendar changes for one doctor. */
async function lockDoctor(tx: Tx, doctorId: string) {
  const [doctor] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
    .for('update');
  if (!doctor) throw unprocessable('DOCTOR_UNAVAILABLE', 'The doctor no longer exists');
}

/**
 * Throws SLOT_UNAVAILABLE if another live booking overlaps [start, end).
 * Live = paid, trial, or an unpaid booking whose hold has not expired.
 * Call inside a transaction that holds the doctor row lock.
 *
 * This must be a locking read: on TiDB a plain SELECT reads the snapshot from
 * the start of the transaction (before the doctor lock was granted) and would
 * miss a booking the previous lock holder just committed. FOR UPDATE reads the
 * latest committed rows on both MySQL and TiDB.
 */
export async function assertSlotFree(tx: Tx, doctorId: string, start: Date, end: Date, excludeId?: string) {
  const [clash] = await tx
    .select({ id: appointments.id, startTime: appointments.startTime, endTime: appointments.endTime })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        inArray(appointments.status, BLOCKING_STATUSES),
        excludeId ? ne(appointments.id, excludeId) : undefined,
        // Half-open interval overlap: [start, end) ∩ [s, e) ≠ ∅
        lt(appointments.startTime, end),
        gt(appointments.endTime, start),
        or(
          eq(appointments.isPaid, true),
          eq(appointments.isTrial, true),
          gt(appointments.holdExpiresAt, new Date()),
        ),
      ),
    )
    .limit(1)
    .for('update');
  if (clash) {
    throw conflict('SLOT_UNAVAILABLE', 'The doctor is already booked for this time', {
      conflictingStart: clash.startTime,
      conflictingEnd: clash.endTime,
    });
  }
}

/**
 * Before taking payment for an unpaid booking: re-validate its slot under the
 * doctor lock and extend the hold, so the patient never pays for a slot that
 * was released and re-booked in the meantime.
 */
export async function reserveSlotForPayment(appointmentId: string, holdMinutes = env.BOOKING_HOLD_MINUTES) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
    if (!row) throw notFound('Appointment');
    if (row.doctorId) {
      await lockDoctor(tx, row.doctorId);
      await assertSlotFree(tx, row.doctorId, row.startTime, row.endTime, row.id);
    }
    const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
    await tx.update(appointments).set({ holdExpiresAt }).where(eq(appointments.id, appointmentId));
  });
}

async function findByIdempotencyKey(userId: string, key: string) {
  const [row] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.userId, userId), eq(appointments.idempotencyKey, key)))
    .limit(1);
  return row ? getAppointmentForUser({ userId, role: 'user' }, row.id) : null;
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const doctorUser = alias(users, 'doctor_user');
const patientUser = alias(users, 'patient_user');

const summaryOf = (u: typeof doctorUser | typeof patientUser) => ({
  id: u.id,
  firstName: u.firstName,
  lastName: u.lastName,
  photoUrl: u.photoUrl,
  role: u.role,
  presence: u.presence,
  lastSeenAt: u.lastSeenAt,
});

type Summary = Parameters<typeof serializeUserSummary>[0];
type JoinedRow = Awaited<ReturnType<typeof baseQuery>>[number];

function serializeAppointment({ appointment: a, doctor, patient }: JoinedRow) {
  return {
    id: a.id,
    status: a.status,
    complaint: a.complaint,
    symptoms: a.symptoms,
    package: { id: a.packageId, name: a.packageLabel, type: a.packageType },
    startTime: a.startTime,
    endTime: a.endTime,
    price: a.price,
    currency: a.currency,
    isTrial: a.isTrial,
    isPaid: a.isPaid,
    paidAt: a.paidAt,
    /** Null while the request is waiting for a doctor to accept it. */
    doctor: doctor?.id ? serializeUserSummary(doctor as Summary) : null,
    patient: serializeUserSummary(patient as Summary), // inner join: always present
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export type AppointmentView = ReturnType<typeof serializeAppointment>;

function baseQuery() {
  return db
    .select({ appointment: appointments, doctor: summaryOf(doctorUser), patient: summaryOf(patientUser) })
    .from(appointments)
    .leftJoin(doctorUser, eq(doctorUser.id, appointments.doctorId))
    .innerJoin(patientUser, eq(patientUser.id, appointments.userId));
}

const participantFilter = (viewer: { userId: string; role: UserRole }) =>
  viewer.role === 'doctor' ? eq(appointments.doctorId, viewer.userId) : eq(appointments.userId, viewer.userId);

export async function listAppointments(
  viewer: { userId: string; role: UserRole },
  query: { limit: number; offset: number; status?: AppointmentStatus },
) {
  const rows = await baseQuery()
    .where(
      and(
        participantFilter(viewer),
        ne(appointments.status, 'deleted'),
        query.status ? eq(appointments.status, query.status) : undefined,
      ),
    )
    .orderBy(desc(appointments.updatedAt))
    .limit(query.limit)
    .offset(query.offset);
  return rows.map(serializeAppointment);
}

/** Paid, upcoming open requests that any doctor may accept. */
export async function listOpenRequests(query: { limit: number; offset: number }) {
  const rows = await baseQuery()
    .where(
      and(
        isNull(appointments.doctorId),
        eq(appointments.status, 'pending'),
        eq(appointments.isPaid, true),
        gt(appointments.endTime, new Date()),
      ),
    )
    .orderBy(appointments.startTime)
    .limit(query.limit)
    .offset(query.offset);
  return rows.map(serializeAppointment);
}

export async function getAppointmentForUser(viewer: { userId: string; role: UserRole }, appointmentId: string) {
  const [row] = await baseQuery().where(eq(appointments.id, appointmentId)).limit(1);
  if (!row || row.appointment.status === 'deleted') throw notFound('Appointment');
  const isParticipant = row.appointment.userId === viewer.userId || row.appointment.doctorId === viewer.userId;
  // Doctors may view an open request before accepting it.
  const isOpenForDoctor = viewer.role === 'doctor' && row.appointment.doctorId === null;
  if (!isParticipant && !isOpenForDoctor) throw notFound('Appointment');
  return serializeAppointment(row);
}

/** Loads the raw row and asserts the caller is a participant. */
export async function requireParticipant(appointmentId: string, userId: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, appointmentId)).limit(1);
  if (!row || row.status === 'deleted') throw notFound('Appointment');
  if (row.userId !== userId && row.doctorId !== userId) throw notFound('Appointment');
  return row;
}

/** Patient soft-deletes an appointment from their list (legacy "delete"). */
export async function deleteAppointment(userId: string, appointmentId: string) {
  const row = await requireParticipant(appointmentId, userId);
  if (row.userId !== userId) throw forbidden('Only the patient can remove this appointment');
  await db.update(appointments).set({ status: 'deleted' }).where(eq(appointments.id, appointmentId));
}

/**
 * A doctor accepts a paid booking: either an open request (claimed atomically —
 * exactly one doctor wins) or one addressed to them. Their calendar is locked
 * and checked for overlaps first.
 */
export async function acceptAppointment(doctorId: string, appointmentId: string) {
  const patientId = await db.transaction(async (tx) => {
    await lockDoctor(tx, doctorId);
    const [row] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (!row || row.status === 'deleted') throw notFound('Appointment');
    if (row.doctorId && row.doctorId !== doctorId) throw conflict('ALREADY_TAKEN', 'Another doctor has accepted this appointment');
    if (row.status !== 'pending') throw conflict('INVALID_TRANSITION', `Appointment is already ${row.status}`);
    if (!row.isPaid) throw unprocessable('NOT_PAID', 'Appointment has not been paid for');
    if (row.userId === doctorId) throw forbidden();

    await assertSlotFree(tx, doctorId, row.startTime, row.endTime, row.id);
    await tx.update(appointments).set({ doctorId, status: 'active' }).where(eq(appointments.id, appointmentId));
    return row.userId;
  });
  realtime.toUser(patientId, 'appointment:updated', { id: appointmentId, status: 'active', isPaid: true });
  void emailAppointmentUpdate(appointmentId, 'accepted');
  return getAppointmentForUser({ userId: doctorId, role: 'doctor' }, appointmentId);
}

const DOCTOR_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ['cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  deleted: [],
};

/** Doctor lifecycle transitions after acceptance (complete, cancel). */
export async function transitionByDoctor(doctorId: string, appointmentId: string, next: AppointmentStatus) {
  const row = await requireParticipant(appointmentId, doctorId);
  if (row.doctorId !== doctorId) throw forbidden();
  if (!DOCTOR_TRANSITIONS[row.status].includes(next)) {
    throw conflict('INVALID_TRANSITION', `Cannot move an appointment from ${row.status} to ${next}`);
  }
  const result = await db
    .update(appointments)
    .set({ status: next })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, row.status)));
  if (affectedRows(result) === 0) throw conflict('CONCURRENT_UPDATE', 'Appointment changed; reload and retry');
  realtime.toUser(row.userId, 'appointment:updated', { id: row.id, status: next, isPaid: row.isPaid });
  if (next === 'completed' || next === 'cancelled') void emailAppointmentUpdate(appointmentId, next);
  return getAppointmentForUser({ userId: doctorId, role: 'doctor' }, appointmentId);
}

export async function touchAppointment(appointmentId: string) {
  await db.update(appointments).set({ updatedAt: sql`CURRENT_TIMESTAMP(3)` }).where(eq(appointments.id, appointmentId));
}
