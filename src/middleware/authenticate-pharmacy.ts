import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pharmacyStaff } from '../db/schema/index.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyPharmacyAccessToken } from '../lib/tokens.js';

export async function authenticatePharmacy(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const claims = verifyPharmacyAccessToken(header.slice('Bearer '.length).trim());
  if (!claims.staffId) {
    req.pharmacyAuth = { pharmacyId: claims.sub, role: 'owner' };
    next();
    return;
  }
  const [staff] = await db
    .select({ pharmacyId: pharmacyStaff.pharmacyId, role: pharmacyStaff.role, status: pharmacyStaff.status, mustChangePassword: pharmacyStaff.mustChangePassword, sessionVersion: pharmacyStaff.sessionVersion })
    .from(pharmacyStaff)
    .where(eq(pharmacyStaff.id, claims.staffId))
    .limit(1);
  if (!staff || staff.pharmacyId !== claims.sub || staff.status !== 'active' || staff.sessionVersion !== claims.sessionVersion) {
    throw unauthorized('This staff account is no longer active');
  }
  const roles = ['manager', 'pharmacist', 'inventory_officer', 'sales_assistant'] as const;
  const role = roles.find((candidate) => candidate === staff.role);
  if (!role) {
    throw unauthorized('Invalid staff role');
  }
  req.pharmacyAuth = {
    pharmacyId: staff.pharmacyId,
    staffId: claims.staffId,
    role,
    mustChangePassword: staff.mustChangePassword,
  };
  if (staff.mustChangePassword && !(req.method === 'GET' && req.path === '/me') && !(req.method === 'PATCH' && req.path === '/password')) {
    throw forbidden('Change your temporary password before using the workspace');
  }
  next();
}

export function currentPharmacy(req: Request) {
  if (!req.pharmacyAuth) throw unauthorized();
  return req.pharmacyAuth;
}

export function requirePharmacyRoles(...roles: Array<NonNullable<Express.Request['pharmacyAuth']>['role']>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = currentPharmacy(req);
    if (auth.role !== 'owner' && !roles.includes(auth.role)) {
      throw forbidden('You do not have access to this workspace feature');
    }
    next();
  };
}
