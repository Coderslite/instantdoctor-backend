import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { UserRole } from '../db/schema/users.js';
import { unauthorized } from './errors.js';

interface AccessClaims {
  sub: string;
  role: UserRole;
}

const ISSUER = 'instantdoctor-api';

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
