import { and, eq, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appointments, savedLocations, userMedicalProfiles, users } from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { z } from 'zod';
import type { savedLocationSchema, updateProfileSchema } from './users.schemas.js';
import { serializeMe, serializeUserSummary } from './users.serializer.js';

export async function getMe(userId: string) {
  const [row] = await db
    .select({ user: users, medical: userMedicalProfiles })
    .from(users)
    .leftJoin(userMedicalProfiles, eq(userMedicalProfiles.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw notFound('User');
  return serializeMe(row.user, row.medical);
}

export async function updateMe(userId: string, input: z.infer<typeof updateProfileSchema>) {
  const { medical, location, ...profile } = input;
  await db.transaction(async (tx) => {
    const patch = {
      ...profile,
      ...(location !== undefined && {
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
      }),
    };
    if (Object.keys(patch).length > 0) await tx.update(users).set(patch).where(eq(users.id, userId));
    if (medical && Object.keys(medical).length > 0) {
      await tx
        .insert(userMedicalProfiles)
        .values({ userId, ...medical })
        .onDuplicateKeyUpdate({ set: medical });
    }
  });
  return getMe(userId);
}

export async function setFcmToken(userId: string, token: string | null) {
  await db.update(users).set({ fcmToken: token }).where(eq(users.id, userId));
}

export async function setPresence(userId: string, presence: 'online' | 'offline' | 'away') {
  await db.update(users).set({ presence, lastSeenAt: new Date() }).where(eq(users.id, userId));
}

export const listSavedLocations = (userId: string) =>
  db.select().from(savedLocations).where(eq(savedLocations.userId, userId)).orderBy(savedLocations.createdAt);

export async function addSavedLocation(userId: string, input: z.infer<typeof savedLocationSchema>) {
  const row = { id: newId(), userId, ...input };
  await db.insert(savedLocations).values(row);
  return row;
}

export async function deleteSavedLocation(userId: string, id: string) {
  await db.delete(savedLocations).where(and(eq(savedLocations.id, id), eq(savedLocations.userId, userId)));
}

export async function isTagAvailable(tag: string) {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.tag, tag)).limit(1);
  return !row;
}

/** Joins the referral programme under a chosen username (tag). */
export async function applyForReferralProgram(userId: string, tag: string) {
  try {
    await db
      .update(users)
      .set({ tag, referralProgramApplied: true, referralProgramAppliedAt: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('TAG_TAKEN', 'This username is already taken');
    throw err;
  }
  return getMe(userId);
}

/**
 * Public summary of another user. Doctors are visible to everyone; a patient is
 * visible only to doctors they share an appointment with.
 */
export async function getUserSummary(viewerId: string, targetId: string) {
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw notFound('User');
  if (target.role !== 'doctor' && target.id !== viewerId) {
    const [shared] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        or(
          and(eq(appointments.userId, targetId), eq(appointments.doctorId, viewerId)),
          and(eq(appointments.userId, viewerId), eq(appointments.doctorId, targetId)),
        ),
      )
      .limit(1);
    if (!shared) throw forbidden();
  }
  return serializeUserSummary(target);
}
