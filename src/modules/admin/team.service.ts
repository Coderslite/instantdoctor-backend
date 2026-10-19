import { and, asc, count, eq, ne } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { admins, type AdminRole } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { permissionsFor, ROLE_INFO } from '../../lib/admin-access.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { closeAllPortalSessions, openPortalSession } from '../auth/portal-sessions.js';
import { signAdminAccessToken } from '../../lib/tokens.js';

/** No look-alike characters, so it survives being read out or typed from an email. */
const temporaryPassword = () => randomCode(12, 'ACDEFGHJKMNPQRTUVWXYabcdefghijkmnpqrtuvwxy34679');

const publicAdmin = (a: typeof admins.$inferSelect) => ({
  id: a.id,
  name: a.name,
  email: a.email,
  role: a.role,
  roleLabel: ROLE_INFO[a.role].label,
  status: a.status,
  mustChangePassword: a.mustChangePassword,
  lastLoginAt: a.lastLoginAt,
  createdAt: a.createdAt,
});

/** The signed-in admin, with what their role can open (the admin UI builds its menu from this). */
export async function me(adminId: string) {
  const [admin] = await db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
  if (!admin) throw notFound('Admin');
  return { ...publicAdmin(admin), roleDescription: ROLE_INFO[admin.role].description, permissions: permissionsFor(admin.role) };
}

export async function changeOwnPassword(adminId: string, currentPassword: string, newPassword: string, userAgent?: string) {
  const [admin] = await db.select().from(admins).where(eq(admins.id, adminId)).limit(1);
  if (!admin?.passwordHash || !(await verifyPassword(currentPassword, admin.passwordHash))) throw unauthorized('Current password is incorrect');
  if (currentPassword === newPassword) throw badRequest('Choose a password different from the current one');
  await db.update(admins).set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false }).where(eq(admins.id, adminId));
  // Other devices sign in again; this one gets a fresh session.
  await closeAllPortalSessions('admin', adminId);
  return {
    admin: await me(adminId),
    session: {
      accessToken: signAdminAccessToken({ sub: adminId, role: admin.role }),
      refreshToken: await openPortalSession('admin', adminId, userAgent),
      tokenType: 'Bearer' as const,
    },
  };
}

export async function listTeam() {
  const rows = await db.select().from(admins).orderBy(asc(admins.status), asc(admins.name));
  return {
    items: rows.map(publicAdmin),
    roles: Object.entries(ROLE_INFO).map(([role, info]) => ({ role, ...info, permissions: permissionsFor(role as AdminRole) })),
  };
}

/** Adds a colleague with a temporary password, emailed to them (and returned once, in case the email goes astray). */
export async function invite(inviterId: string, input: { name: string; email: string; role: AdminRole }) {
  const [inviter] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, inviterId)).limit(1);
  const email = input.email.toLowerCase();
  const password = temporaryPassword();
  const id = newId();
  try {
    await db.insert(admins).values({ id, name: input.name, email, role: input.role, passwordHash: await hashPassword(password), mustChangePassword: true });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('EMAIL_TAKEN', 'There is already an admin account with this email');
    throw err;
  }
  void mailer
    .adminInvited({
      to: email,
      name: input.name,
      invitedBy: inviter?.name ?? 'An Instant Doctor admin',
      roleLabel: ROLE_INFO[input.role].label,
      roleDescription: ROLE_INFO[input.role].description,
      email,
      password,
      adminUrl: env.ADMIN_URL,
    })
    .catch((err: unknown) => logger.error({ err, id }, 'Admin invite email failed'));
  const [row] = await db.select().from(admins).where(eq(admins.id, id));
  return { admin: publicAdmin(row!), temporaryPassword: password };
}

/** There must always be at least one active full admin. */
async function assertAnotherAdmin(exceptId: string) {
  const [other] = await db
    .select({ n: count() })
    .from(admins)
    .where(and(eq(admins.role, 'admin'), eq(admins.status, 'active'), ne(admins.id, exceptId)));
  if (!other?.n) throw conflict('LAST_ADMIN', 'At least one active Admin must remain. Make someone else an Admin first.');
}

export async function update(actorId: string, id: string, input: { role?: AdminRole; status?: 'active' | 'inactive'; name?: string }) {
  const [admin] = await db.select().from(admins).where(eq(admins.id, id)).limit(1);
  if (!admin) throw notFound('Admin');
  if (id === actorId && (input.status === 'inactive' || (input.role && input.role !== admin.role)))
    throw badRequest('You can’t change your own role or deactivate yourself. Ask another Admin.');
  const losesAdmin = admin.role === 'admin' && admin.status === 'active' && ((input.role && input.role !== 'admin') || input.status === 'inactive');
  if (losesAdmin) await assertAnotherAdmin(id);
  await db.update(admins).set(input).where(eq(admins.id, id));
  // Signed out everywhere when switched off; a role change applies on their next request.
  if (input.status === 'inactive') await closeAllPortalSessions('admin', id);
  const [row] = await db.select().from(admins).where(eq(admins.id, id));
  return publicAdmin(row!);
}

/** A new temporary password, emailed; they choose their own at next sign-in. */
export async function resetPassword(actorId: string, id: string) {
  const [admin] = await db.select().from(admins).where(eq(admins.id, id)).limit(1);
  if (!admin) throw notFound('Admin');
  if (id === actorId) throw badRequest('Change your own password from your account instead.');
  const password = temporaryPassword();
  await db.update(admins).set({ passwordHash: await hashPassword(password), mustChangePassword: true }).where(eq(admins.id, id));
  await closeAllPortalSessions('admin', id);
  const [actor] = await db.select({ name: admins.name }).from(admins).where(eq(admins.id, actorId)).limit(1);
  void mailer
    .adminInvited({
      to: admin.email,
      name: admin.name,
      invitedBy: actor?.name ?? 'An Instant Doctor admin',
      roleLabel: ROLE_INFO[admin.role].label,
      roleDescription: ROLE_INFO[admin.role].description,
      email: admin.email,
      password,
      adminUrl: env.ADMIN_URL,
    })
    .catch((err: unknown) => logger.error({ err, id }, 'Admin password reset email failed'));
  return { admin: publicAdmin(admin), temporaryPassword: password };
}
