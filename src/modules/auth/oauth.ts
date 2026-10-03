import { OAuth2Client } from 'google-auth-library';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { serviceUnavailable, unauthorized } from '../../lib/errors.js';

export interface ExternalIdentity {
  provider: 'google' | 'apple';
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  photoUrl?: string;
}

const googleClient = new OAuth2Client();

export async function verifyGoogleIdToken(idToken: string): Promise<ExternalIdentity> {
  if (env.GOOGLE_CLIENT_IDS.length === 0) throw serviceUnavailable('Google sign-in is not configured');
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_IDS });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error('missing subject');
    return {
      provider: 'google',
      providerUserId: p.sub,
      email: p.email?.toLowerCase() ?? null,
      emailVerified: p.email_verified === true,
      firstName: p.given_name ?? p.name,
      lastName: p.family_name,
      photoUrl: p.picture,
    };
  } catch {
    throw unauthorized('Invalid Google ID token');
  }
}

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function verifyAppleIdentityToken(identityToken: string): Promise<ExternalIdentity> {
  if (env.APPLE_CLIENT_IDS.length === 0) throw serviceUnavailable('Apple sign-in is not configured');
  try {
    const { payload } = await jwtVerify(identityToken, appleKeys, {
      issuer: 'https://appleid.apple.com',
      audience: env.APPLE_CLIENT_IDS,
    });
    if (!payload.sub) throw new Error('missing subject');
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    return {
      provider: 'apple',
      providerUserId: payload.sub,
      email,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    };
  } catch {
    throw unauthorized('Invalid Apple identity token');
  }
}

/**
 * Checks an email/password against the legacy Firebase Auth project.
 * Returns the Firebase uid on success, null on bad credentials.
 */
export async function verifyLegacyFirebasePassword(email: string, password: string): Promise<string | null> {
  if (!env.FIREBASE_WEB_API_KEY) return null;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json()) as { localId?: string };
  return body.localId ?? null;
}
