import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors.js';
import { verifyPharmacyAccessToken } from '../lib/tokens.js';

export function authenticatePharmacy(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyPharmacyAccessToken(header.slice('Bearer '.length).trim());
  req.pharmacyAuth = { pharmacyId: claims.sub };
  next();
}

export function currentPharmacy(req: Request) {
  if (!req.pharmacyAuth) throw unauthorized();
  return req.pharmacyAuth;
}
