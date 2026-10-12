import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { hmoUsers } from '../../db/schema/index.js';
import { hashPassword } from '../../lib/crypto.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { closeAllPortalSessions } from '../auth/portal-sessions.js';
import { changedFields, describeChanges, recordActivity, type Actor } from './hmo.activity.js';
import { requireHmo } from './hmo.agreements.js';
import type { hmoUserSchema, updateHmoUserSchema } from './hmo.schemas.js';

/**
 * HMO portal accounts. Instant Doctor admins create an HMO's first account;
 * the HMO's own admins then manage their team. Scoped to one HMO throughout.
 */

const publicColumns = {
  id: hmoUsers.id,
  name: hmoUsers.name,
  email: hmoUsers.email,
  role: hmoUsers.role,
  status: hmoUsers.status,
  mustChangePassword: hmoUsers.mustChangePassword,
  lastLoginAt: hmoUsers.lastLoginAt,
  createdAt: hmoUsers.createdAt,
};

export async function listUsers(hmoId: string) {
  await requireHmo(hmoId);
  return db
    .select(publicColumns)
    .from(hmoUsers)
    .where(eq(hmoUsers.hmoId, hmoId))
    .orderBy(asc(hmoUsers.name));
}

export async function requireUser(hmoId: string, userId: string) {
  const [user] = await db
    .select(publicColumns)
    .from(hmoUsers)
    .where(and(eq(hmoUsers.id, userId), eq(hmoUsers.hmoId, hmoId)))
    .limit(1);
  if (!user) throw notFound('Portal user');
  return user;
}

/** New accounts get a temporary password and must choose their own at first sign-in. */
export async function createUser(
  hmoId: string,
  input: z.infer<typeof hmoUserSchema>,
  actor: Actor,
) {
  await requireHmo(hmoId);
  const id = newId();
  try {
    await db.insert(hmoUsers).values({
      id,
      hmoId,
      name: input.name,
      email: input.email.toLowerCase(),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      mustChangePassword: true,
    });
  } catch (err) {
    if (isDuplicateKeyError(err))
      throw conflict('EMAIL_TAKEN', 'Another portal account already uses that email');
    throw err;
  }
  const user = await requireUser(hmoId, id);
  await recordActivity(hmoId, actor, {
    action: 'team.created',
    entityType: 'user',
    entityId: id,
    summary: `Gave ${user.name} (${user.email}) ${user.role} access to the portal`,
  });
  return user;
}

/** At least one active admin must remain, or nobody at the HMO could manage the team. */
async function keepsAnAdmin(hmoId: string, userId: string) {
  const [other] = await db
    .select({ id: hmoUsers.id })
    .from(hmoUsers)
    .where(
      and(
        eq(hmoUsers.hmoId, hmoId),
        ne(hmoUsers.id, userId),
        eq(hmoUsers.role, 'admin'),
        eq(hmoUsers.status, 'active'),
      ),
    )
    .limit(1);
  if (!other) throw conflict('LAST_ADMIN', 'Keep at least one active admin on the portal');
}

export async function updateUser(
  hmoId: string,
  userId: string,
  input: z.infer<typeof updateHmoUserSchema>,
  actor: Actor,
) {
  const current = await requireUser(hmoId, userId);
  const demoted = input.role !== undefined && input.role !== 'admin';
  const deactivated = input.status === 'inactive';
  if (current.role === 'admin' && current.status === 'active' && (demoted || deactivated))
    await keepsAnAdmin(hmoId, userId);
  // Role and status are read on every request, so both apply at once without a sign-out.
  await db.update(hmoUsers).set(input).where(eq(hmoUsers.id, userId));
  if (deactivated) await closeAllPortalSessions('hmo_user', userId);
  const updated = await requireUser(hmoId, userId);
  const diff = changedFields(current, updated, ['name', 'role', 'status']);
  if (Object.keys(diff).length) {
    await recordActivity(hmoId, actor, {
      action: 'team.updated',
      entityType: 'user',
      entityId: userId,
      summary: `Updated ${current.name}'s portal access: ${describeChanges(diff, { name: 'name', role: 'role', status: 'status' })}`,
      details: { changes: diff },
    });
  }
  return updated;
}

/** Sets a temporary password and signs the person out everywhere. */
export async function resetPassword(hmoId: string, userId: string, password: string, actor: Actor) {
  const user = await requireUser(hmoId, userId);
  await db
    .update(hmoUsers)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      sessionVersion: sql`${hmoUsers.sessionVersion} + 1`,
    })
    .where(eq(hmoUsers.id, userId));
  await closeAllPortalSessions('hmo_user', userId);
  await recordActivity(hmoId, actor, {
    action: 'team.password_reset',
    entityType: 'user',
    entityId: userId,
    summary: `Set a temporary password for ${user.name}`,
  });
  return requireUser(hmoId, userId);
}
