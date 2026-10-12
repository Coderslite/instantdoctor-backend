import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { hmoUsers, type HmoUserRole } from '../db/schema/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyHmoAccessToken } from '../lib/tokens.js';

/**
 * HMO portal requests. The account is re-read on every request so that a
 * deactivation, role change or password reset takes effect immediately.
 */
export async function authenticateHmo(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyHmoAccessToken(header.slice('Bearer '.length).trim());
  const [user] = await db
    .select({
      hmoId: hmoUsers.hmoId,
      name: hmoUsers.name,
      role: hmoUsers.role,
      status: hmoUsers.status,
      mustChangePassword: hmoUsers.mustChangePassword,
      sessionVersion: hmoUsers.sessionVersion,
    })
    .from(hmoUsers)
    .where(eq(hmoUsers.id, claims.sub))
    .limit(1);
  if (
    !user ||
    user.hmoId !== claims.hmoId ||
    user.status !== 'active' ||
    user.sessionVersion !== claims.sessionVersion
  ) {
    throw unauthorized('This account is no longer active');
  }
  req.hmoAuth = {
    hmoId: user.hmoId,
    userId: claims.sub,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
  const passwordRoute =
    (req.method === 'GET' && req.path === '/me') ||
    (req.method === 'PATCH' && req.path === '/password');
  if (user.mustChangePassword && !passwordRoute) {
    throw forbidden(
      'Change your temporary password before using the portal',
      'PASSWORD_CHANGE_REQUIRED',
    );
  }
  next();
}

export function currentHmo(req: Request) {
  if (!req.hmoAuth) throw unauthorized();
  return req.hmoAuth;
}

/** HMO admins can do everything; list the other roles allowed. */
export function requireHmoRoles(...roles: HmoUserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = currentHmo(req);
    if (auth.role !== 'admin' && !roles.includes(auth.role)) {
      throw forbidden('Your role does not allow this. Ask your HMO admin.');
    }
    next();
  };
}
