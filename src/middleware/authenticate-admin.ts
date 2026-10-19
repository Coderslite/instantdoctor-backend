import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { admins } from '../db/schema/index.js';
import { allows } from '../lib/admin-access.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAdminAccessToken } from '../lib/tokens.js';

/** The request's path inside /admin, e.g. /patients/123. */
const adminPath = (req: Request) => `${req.baseUrl}${req.path}`.replace(/^.*?\/admin(?=\/|$)/, '') || '/';

/** With a temporary password only the account itself is open (to change it). */
const temporaryPasswordAllows = (path: string) => /^\/me(\/|$)/.test(path);

/**
 * Signs in an admin request and checks the role may use this part of the admin
 * (see lib/admin-access.ts). The role and status are read fresh each time, so
 * a role change or deactivation takes effect on the next request.
 */
export async function authenticateAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyAdminAccessToken(header.slice('Bearer '.length).trim());
  const [admin] = await db
    .select({ role: admins.role, status: admins.status, mustChangePassword: admins.mustChangePassword })
    .from(admins)
    .where(eq(admins.id, claims.sub))
    .limit(1);
  if (!admin || admin.status !== 'active') throw unauthorized('This admin account is no longer active');
  req.adminAuth = { adminId: claims.sub, role: admin.role };
  const path = adminPath(req);
  if (admin.mustChangePassword && !temporaryPasswordAllows(path))
    throw forbidden('Choose your own password before using the admin');
  if (!allows(admin.role, req.method, path)) throw forbidden('Your role doesn’t have access to this');
  next();
}

export function currentAdmin(req: Request) {
  if (!req.adminAuth) throw unauthorized();
  return req.adminAuth;
}
