import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { AdminRole, UserRole } from '../db/schema/users.js';
import { unauthorized } from './errors.js';

interface AccessClaims {
  sub: string;
  role: UserRole;
}

const ISSUER = 'instantdoctor-api';
const ADMIN_ISSUER = 'instantdoctor-admin-api';
const PHARMACY_ISSUER = 'instantdoctor-pharmacy-api';
const HMO_ISSUER = 'instantdoctor-hmo-api';

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ role: claims.role }, env.JWT_ACCESS_SECRET, {
    subject: claims.sub,
    issuer: ISSUER,
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (!payload.sub || (payload.role !== 'user' && payload.role !== 'doctor')) {
      throw unauthorized('Invalid access token');
    }
    return { sub: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

interface AdminAccessClaims {
  sub: string;
  role: AdminRole;
}

export function signAdminAccessToken(claims: AdminAccessClaims): string {
  return jwt.sign({ role: claims.role }, env.JWT_ACCESS_SECRET, {
    subject: claims.sub,
    issuer: ADMIN_ISSUER,
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAdminAccessToken(token: string): AdminAccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: ADMIN_ISSUER,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (!payload.sub || (payload.role !== 'admin' && payload.role !== 'marketer')) {
      throw unauthorized('Invalid admin access token');
    }
    return { sub: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('Invalid or expired admin access token');
  }
}

export function signPharmacyAccessToken(pharmacyId: string): string {
  return jwt.sign({ role: 'pharmacy' }, env.JWT_ACCESS_SECRET, {
    subject: pharmacyId,
    issuer: PHARMACY_ISSUER,
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signPharmacyStaffAccessToken(pharmacyId: string, staffId: string, sessionVersion: number): string {
  return jwt.sign({ role: 'pharmacy_staff', staffId, sessionVersion }, env.JWT_ACCESS_SECRET, {
    subject: pharmacyId,
    issuer: PHARMACY_ISSUER,
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyPharmacyAccessToken(token: string): { sub: string; staffId?: string; sessionVersion?: number } {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: PHARMACY_ISSUER, algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!payload.sub) throw unauthorized('Invalid pharmacy access token');
    if (payload.role === 'pharmacy') return { sub: payload.sub };
    if (payload.role === 'pharmacy_staff' && typeof payload.staffId === 'string') {
      if (!Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion < 0) {
        throw unauthorized('Invalid pharmacy staff access token');
      }
      return { sub: payload.sub, staffId: payload.staffId, sessionVersion: payload.sessionVersion };
    }
    throw unauthorized('Invalid pharmacy access token');
  } catch {
    throw unauthorized('Invalid or expired pharmacy access token');
  }
}

interface HmoAccessClaims {
  /** The HMO portal user. */
  sub: string;
  hmoId: string;
  sessionVersion: number;
}

export function signHmoAccessToken(claims: HmoAccessClaims): string {
  return jwt.sign(
    { role: 'hmo_user', hmoId: claims.hmoId, sessionVersion: claims.sessionVersion },
    env.JWT_ACCESS_SECRET,
    {
      subject: claims.sub,
      issuer: HMO_ISSUER,
      algorithm: 'HS256',
      expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    },
  );
}

export function verifyHmoAccessToken(token: string): HmoAccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: HMO_ISSUER,
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    if (
      !payload.sub ||
      payload.role !== 'hmo_user' ||
      typeof payload.hmoId !== 'string' ||
      !Number.isSafeInteger(payload.sessionVersion) ||
      payload.sessionVersion < 0
    ) {
      throw unauthorized('Invalid HMO access token');
    }
    return { sub: payload.sub, hmoId: payload.hmoId, sessionVersion: payload.sessionVersion };
  } catch {
    throw unauthorized('Invalid or expired HMO access token');
  }
}
