import { and, asc, count, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { familyProfiles } from '../../db/schema/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { familyProfileSchema, updateFamilyProfileSchema } from './family.schemas.js';
import { requireFamilyCareAccess } from '../subscriptions/subscriptions.service.js';

/** A household rarely needs more; the cap keeps abuse and UI sane. */
export const MAX_FAMILY_PROFILES = 5;

type Profile = typeof familyProfiles.$inferSelect;

export const serializeProfile = (p: Profile) => ({
  id: p.id,
  name: p.name,
  relationship: p.relationship,
  dateOfBirth: p.dateOfBirth,
  sex: p.sex,
  bloodGroup: p.bloodGroup,
  genotype: p.genotype,
  allergies: p.allergies,
  conditions: p.conditions,
  caregiverReminders: p.caregiverReminders,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export async function requireOwnedProfile(ownerUserId: string, id: string) {
  const [row] = await db
    .select()
    .from(familyProfiles)
    .where(and(eq(familyProfiles.id, id), eq(familyProfiles.ownerUserId, ownerUserId)))
    .limit(1);
  if (!row) throw notFound('Family profile');
  return row;
}

/**
 * Turns a client-supplied profile reference into a verified profile id, or
 * null for the account owner. Throws 404 for profiles the caller doesn't own.
 */
export async function resolveProfileId(ownerUserId: string, profileId: string | null | undefined) {
  if (!profileId || profileId === 'me') return null;
  await requireOwnedProfile(ownerUserId, profileId);
  return profileId;
}

export async function listProfiles(ownerUserId: string) {
  const rows = await db
    .select()
    .from(familyProfiles)
    .where(eq(familyProfiles.ownerUserId, ownerUserId))
    .orderBy(asc(familyProfiles.createdAt));
  return rows.map(serializeProfile);
}

export async function getProfile(ownerUserId: string, id: string) {
  return serializeProfile(await requireOwnedProfile(ownerUserId, id));
}

export async function createProfile(ownerUserId: string, input: z.infer<typeof familyProfileSchema>) {
  await requireFamilyCareAccess(ownerUserId);
  const [row] = await db
    .select({ total: count() })
    .from(familyProfiles)
    .where(eq(familyProfiles.ownerUserId, ownerUserId));
  if ((row?.total ?? 0) >= MAX_FAMILY_PROFILES) {
    throw conflict('FAMILY_LIMIT_REACHED', `You can manage up to ${MAX_FAMILY_PROFILES} family members`);
  }
  const id = newId();
  await db.insert(familyProfiles).values({ id, ownerUserId, ...input });
  return getProfile(ownerUserId, id);
}

export async function updateProfile(ownerUserId: string, id: string, input: z.infer<typeof updateFamilyProfileSchema>) {
  await requireOwnedProfile(ownerUserId, id);
  if (Object.keys(input).length > 0) {
    await db.update(familyProfiles).set(input).where(eq(familyProfiles.id, id));
  }
  return getProfile(ownerUserId, id);
}

/** Deletes the person and, by cascade, their care plans, medications and share links. */
export async function deleteProfile(ownerUserId: string, id: string) {
  await requireOwnedProfile(ownerUserId, id);
  await db.delete(familyProfiles).where(eq(familyProfiles.id, id));
}
