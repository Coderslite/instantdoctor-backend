import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '../db/schema/users.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAdminAccessToken } from '../lib/tokens.js';

export function authenticateAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyAdminAccessToken(header.slice('Bearer '.length).trim());
  req.adminAuth = { adminId: claims.sub, role: claims.role };
  next();
}

export const requireAdminRole =
  (...roles: AdminRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.adminAuth) throw unauthorized();
    if (!roles.includes(req.adminAuth.role)) throw forbidden();
    next();
  };

export function currentAdmin(req: Request) {
  if (!req.adminAuth) throw unauthorized();
  return req.adminAuth;
}
