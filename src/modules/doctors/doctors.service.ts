import { and, asc, avg, count, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { appointments, doctorProfiles, reviews, users } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import type { Pagination } from '../../lib/pagination.js';
import { serializeDoctor } from '../users/users.serializer.js';

async function reviewStats(doctorIds: string[]) {
  if (doctorIds.length === 0) return new Map<string, { reviewCount: number; averageRating: number | null }>();
  const rows = await db
    .select({ doctorId: reviews.doctorId, reviewCount: count(), averageRating: avg(reviews.rating) })
    .from(reviews)
    .where(inArray(reviews.doctorId, doctorIds))
    .groupBy(reviews.doctorId);
  return new Map(
    rows.map((r) => [
      r.doctorId,
      { reviewCount: r.reviewCount, averageRating: r.averageRating === null ? null : Math.round(Number(r.averageRating) * 10) / 10 },
    ]),
  );
}

/** Available doctors, most recently active first. */
export async function listAvailableDoctors(limit: number) {
  const rows = await db
    .select({ user: users, profile: doctorProfiles })
    .from(users)
    .innerJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
    .where(and(eq(users.role, 'doctor'), eq(doctorProfiles.isAvailable, true)))
    // MySQL sorts NULLs first ascending / last descending, matching the app's "nulls last".
    .orderBy(desc(users.lastSeenAt))
    .limit(limit);
  const stats = await reviewStats(rows.map((r) => r.user.id));
  return rows.map((r) => serializeDoctor(r.user, r.profile, stats.get(r.user.id)));
}

export async function getDoctor(doctorId: string) {
  const [row] = await db
    .select({ user: users, profile: doctorProfiles })
    .from(users)
    .leftJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
    .where(and(eq(users.id, doctorId), eq(users.role, 'doctor')))
    .limit(1);
  if (!row) throw notFound('Doctor');
  const stats = await reviewStats([doctorId]);
  return serializeDoctor(row.user, row.profile, stats.get(doctorId));
}

export async function listDoctorReviews(doctorId: string, { limit, offset }: Pagination) {
  return db
    .select({
      id: reviews.id,
      rating: reviews.rating,
      review: reviews.review,
      appointmentId: reviews.appointmentId,
      createdAt: reviews.createdAt,
      reviewer: { id: users.id, firstName: users.firstName, photoUrl: users.photoUrl },
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(eq(reviews.doctorId, doctorId))
    .orderBy(desc(reviews.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Picks the available doctor active in the last 24h (and not "away") who has
 * completed the fewest consultations in the last 24h. Null if nobody qualifies.
 */
export async function findLeastBusyDoctor(): Promise<string | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      id: users.id,
      load: sql<number>`count(${appointments.id})`.as('load'),
    })
    .from(users)
    .innerJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
    .leftJoin(
      appointments,
      and(
        eq(appointments.doctorId, users.id),
        eq(appointments.status, 'completed'),
        gte(appointments.updatedAt, since),
      ),
    )
    .where(
      and(
        eq(users.role, 'doctor'),
        eq(doctorProfiles.isAvailable, true),
        isNotNull(users.lastSeenAt),
        gte(users.lastSeenAt, since),
        ne(users.presence, 'away'),
      ),
    )
    .groupBy(users.id)
    .orderBy(asc(sql`load`), desc(users.lastSeenAt))
    .limit(1);
  return row?.id ?? null;
}

/** FCM tokens for doctor broadcast (new appointment alerts). */
export async function doctorPushTokens(executor: Executor = db, onlyDoctorId?: string) {
  const rows = await executor
    .select({ token: users.fcmToken })
    .from(users)
    .where(and(eq(users.role, 'doctor'), onlyDoctorId ? eq(users.id, onlyDoctorId) : undefined));
  return rows.map((r) => r.token);
}
