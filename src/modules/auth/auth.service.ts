import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  authIdentities,
  otpCodes,
  referrals,
  refreshTokens,
  userMedicalProfiles,
  users,
  type OtpPurpose,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { hashPassword, sha256, verifyPassword } from '../../lib/crypto.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { signAccessToken } from '../../lib/tokens.js';
import { serializeMe } from '../users/users.serializer.js';
import type { ExternalIdentity } from './oauth.js';
import { verifyLegacyFirebasePassword } from './oauth.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_INTERVAL_MS = 60 * 1000;

type UserRow = typeof users.$inferSelect;

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
}

async function issueSession(user: Pick<UserRow, 'id' | 'role'>, userAgent?: string, familyId = newId()): Promise<Session> {
  const refreshToken = randomToken();
  await db.insert(refreshTokens).values({
    id: newId(),
    userId: user.id,
    tokenHash: sha256(refreshToken),
    familyId,
    userAgent: userAgent?.slice(0, 255) ?? null,
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000),
  });
  return { accessToken: signAccessToken({ sub: user.id, role: user.role }), refreshToken, tokenType: 'Bearer' };
}

/**
 * Rotates a refresh token. Presenting an already-rotated token is treated as
 * theft: the whole token family is revoked and the user must sign in again.
 */
export async function refreshSession(refreshToken: string, userAgent?: string): Promise<Session> {
  const [token] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(refreshToken)))
    .limit(1);
  if (!token || token.expiresAt < new Date()) throw unauthorized('Invalid refresh token');

  if (token.revokedAt) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, token.familyId), isNull(refreshTokens.revokedAt)));
    logger.warn({ userId: token.userId }, 'Refresh token reuse detected; session family revoked');
    throw unauthorized('Invalid refresh token');
  }

  const [user] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, token.userId));
  if (!user) throw unauthorized('Invalid refresh token');

  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, token.id));
  return issueSession(user, userAgent, token.familyId);
}

export async function revokeRefreshToken(refreshToken: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, sha256(refreshToken)), isNull(refreshTokens.revokedAt)));
}

async function revokeAllSessions(userId: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

// ─── OTP ─────────────────────────────────────────────────────────────────────

const otpHash = (email: string, purpose: OtpPurpose, code: string) => sha256(`${email}:${purpose}:${code}`);

export async function requestOtp(email: string, purpose: OtpPurpose) {
  const existing = await findUserByEmail(email);
  if (purpose === 'register' && existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  // For login/reset, respond identically whether or not the account exists (no enumeration).
  if (purpose !== 'register' && !existing) return;

  const [latest] = await db
    .select({ createdAt: otpCodes.createdAt })
    .from(otpCodes)
    .where(and(eq(otpCodes.email, email), eq(otpCodes.purpose, purpose)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_INTERVAL_MS) {
    throw conflict('OTP_RATE_LIMITED', 'Please wait a minute before requesting another code');
  }

  const code = String(randomInt(10_000, 100_000)); // 5 digits, as the app expects
  await db.insert(otpCodes).values({
    id: newId(),
    email,
    purpose,
    codeHash: otpHash(email, purpose, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  await mailer.otp(email, code);
}

/** Consumes a valid OTP or throws. Each wrong guess counts against the latest code. */
export async function consumeOtp(email: string, purpose: OtpPurpose, code: string, executor: Executor = db) {
  const [otp] = await executor
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.email, email),
        eq(otpCodes.purpose, purpose),
        isNull(otpCodes.consumedAt),
        gt(otpCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw badRequest('Invalid or expired verification code');
  if (otp.codeHash !== otpHash(email, purpose, code)) {
    await executor.update(otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(otpCodes.id, otp.id));
    throw badRequest('Invalid or expired verification code');
  }
  await executor.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, otp.id));
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function findUserByEmail(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user ?? null;
}

export async function isEmailAvailable(email: string) {
  return !(await findUserByEmail(email));
}

/** Referral tag: first two letters of the first name + 8 digits (time-derived + random). */
function generateTag(firstName: string): string {
  const prefix = (firstName.toLowerCase().replace(/[^a-z]/g, '') + 'xx').slice(0, 2);
  return `${prefix}${String(Date.now()).slice(-7)}${randomInt(0, 10)}`;
}

interface NewUserInput {
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string | null;
  phoneNumber?: string | null;
  gender?: string | null;
  photoUrl?: string | null;
  platform?: string | null;
  emailVerified: boolean;
  referredBy?: string | null;
  identity?: Pick<ExternalIdentity, 'provider' | 'providerUserId'>;
}

async function createUser(input: NewUserInput): Promise<UserRow> {
  const userId = newId();
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          email: input.email,
          passwordHash: input.passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          phoneNumber: input.phoneNumber ?? null,
          gender: input.gender ?? null,
          photoUrl: input.photoUrl ?? null,
          platform: input.platform ?? null,
          tag: generateTag(input.firstName),
          emailVerifiedAt: input.emailVerified ? new Date() : null,
          lastSeenAt: new Date(),
        });
        await tx.insert(userMedicalProfiles).values({ userId });
        if (input.identity) {
          await tx.insert(authIdentities).values({ id: newId(), userId, ...input.identity });
        }
        if (input.referredBy) await attachReferral(tx, userId, input.referredBy);
      });
      break;
    } catch (err) {
      // Tag collision: retry with a fresh tag. Email collision: surface to the caller.
      if (isDuplicateKeyError(err) && String((err as Error).message).includes('users_tag_uq') && attempt < 3) continue;
      if (isDuplicateKeyError(err)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
  }
  void mailer.welcome(input.email);
  void mailer.activity(userId, 'Registration');
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user!;
}

async function attachReferral(executor: Executor, userId: string, referrerTag: string) {
  const tag = referrerTag.trim().toLowerCase();
  const [referrer] = await executor.select({ id: users.id }).from(users).where(eq(users.tag, tag)).limit(1);
  if (!referrer || referrer.id === userId) return; // Unknown codes are ignored, as in the app.
  await executor.insert(referrals).values({ id: newId(), userId, referrerTag: tag, referrerId: referrer.id });
}

async function loadMe(user: UserRow) {
  const [medical] = await db.select().from(userMedicalProfiles).where(eq(userMedicalProfiles.userId, user.id));
  return serializeMe(user, medical);
}

// ─── Flows ───────────────────────────────────────────────────────────────────

export async function register(
  input: {
    email: string;
    password: string;
    otp: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    gender: string;
    platform?: string;
    referredBy?: string;
  },
  userAgent?: string,
) {
  await consumeOtp(input.email, 'register', input.otp);
  const user = await createUser({
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    phoneNumber: input.phoneNumber,
    gender: input.gender,
    platform: input.platform,
    passwordHash: await hashPassword(input.password),
    emailVerified: true,
    referredBy: input.referredBy,
  });
  return { user: await loadMe(user), session: await issueSession(user, userAgent) };
}

export async function login(email: string, password: string, userAgent?: string) {
  const user = await findUserByEmail(email);
  if (!user) throw unauthorized('Invalid email or password');

  let ok = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
  if (!ok && user.legacyAuth) {
    // Lazy migration: the password may have been reset in Firebase after the data export.
    const firebaseUid = await verifyLegacyFirebasePassword(email, password);
    ok = firebaseUid === user.id;
  }
  if (!ok) throw unauthorized('Invalid email or password');

  if (user.legacyAuth || !user.passwordHash) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), legacyAuth: false })
      .where(eq(users.id, user.id));
  }
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  return { user: await loadMe(user), session: await issueSession(user, userAgent) };
}

/** Google / Apple sign-in: link by provider id, then by verified email, else create. */
export async function socialSignIn(
  identity: ExternalIdentity,
  extra: { firstName?: string; lastName?: string; referredBy?: string; platform?: string },
  userAgent?: string,
) {
  const [linked] = await db
    .select({ user: users })
    .from(authIdentities)
    .innerJoin(users, eq(users.id, authIdentities.userId))
    .where(and(eq(authIdentities.provider, identity.provider), eq(authIdentities.providerUserId, identity.providerUserId)))
    .limit(1);

  let user = linked?.user ?? null;
  let isNewUser = false;

  if (!user && identity.email && identity.emailVerified) {
    user = await findUserByEmail(identity.email);
    if (user) {
      await db.insert(authIdentities).values({
        id: newId(),
        userId: user.id,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
      });
    }
  }

  if (!user) {
    // Apple may withhold the email; fall back to a stable placeholder (legacy behaviour).
    const email = identity.email ?? `${identity.providerUserId}@${identity.provider}.user`;
    user = await createUser({
      email,
      firstName: extra.firstName ?? identity.firstName ?? '',
      lastName: extra.lastName ?? identity.lastName ?? '',
      photoUrl: identity.photoUrl,
      platform: extra.platform,
      passwordHash: null,
      emailVerified: identity.emailVerified,
      referredBy: extra.referredBy,
      identity,
    });
    isNewUser = true;
  }

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  return { user: await loadMe(user), session: await issueSession(user, userAgent), isNewUser };
}

export async function resetPassword(email: string, otp: string, newPassword: string) {
  const user = await findUserByEmail(email);
  if (!user) throw badRequest('Invalid or expired verification code');
  await consumeOtp(email, 'password_reset', otp);
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), legacyAuth: false })
    .where(eq(users.id, user.id));
  await revokeAllSessions(user.id);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw unauthorized();
  if (user.passwordHash && !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw badRequest('Current password is incorrect');
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), legacyAuth: false })
    .where(eq(users.id, userId));
  await revokeAllSessions(userId);
}
