import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';
import type { UserRole } from '../db/schema/users.js';

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyAccessToken(header.slice('Bearer '.length).trim());
  req.auth = { userId: claims.sub, role: claims.role };
  next();
}

export const requireRole =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };

/** Narrowing accessor for handlers mounted behind `authenticate`. */
export function currentUser(req: Request) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
