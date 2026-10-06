import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  authIdentities,
  otpCodes,
  passwordResetTokens,
  referrals,
  refreshTokens,
  userMedicalProfiles,
  users,
  type OtpPurpose,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { hashPassword, sha256, verifyPassword } from '../../lib/crypto.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { newId, randomToken } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { signAccessToken } from '../../lib/tokens.js';
import { serializeMe } from '../users/users.serializer.js';
import type { ExternalIdentity } from './oauth.js';
import { verifyLegacyFirebasePassword } from './oauth.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_INTERVAL_MS = 60 * 1000;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

type UserRow = typeof users.$inferSelect;

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
}

export interface ClientInfo {
  userAgent?: string;
  platform?: string;
  ip?: string;
}

export function describeDevice(client?: ClientInfo): string {
  const platform = client?.platform?.toLowerCase();
  if (platform === 'android') return 'Instant Doctor app on Android';
  if (platform === 'ios') return 'Instant Doctor app on iPhone';
  if (client?.userAgent && /mozilla/i.test(client.userAgent)) return 'Web browser';
  return 'Unknown device';
}

function alertSignIn(user: Pick<UserRow, 'email' | 'firstName'>, client?: ClientInfo) {
  void mailer.signInAlert({
    to: user.email,
    firstName: user.firstName,
    device: describeDevice(client),
    ipAddress: client?.ip?.replace(/^::ffff:/, ""),
  });
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

/** Generates, stores (hashed) and emails a code. One code per minute per email/purpose. */
async function issueOtp(email: string, purpose: OtpPurpose) {
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
  const owner = await findUserByEmail(email);
  await mailer.verificationCode({
    to: email,
    code,
    purpose,
    firstName: owner?.firstName,
    expiresInMinutes: OTP_TTL_MS / 60_000,
  });
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

/** Free to register: no account, or only an unverified sign-up (which re-registering replaces). */
export async function isEmailAvailable(email: string) {
  const user = await findUserByEmail(email);
  return !user || user.registrationStatus === 'pending_verification';
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
  /** False for email/password sign-ups until the emailed code is confirmed. */
  emailVerified: boolean;
  pendingVerification?: boolean;
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
          registrationStatus: input.pendingVerification ? 'pending_verification' : 'active',
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
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!input.pendingVerification) onActivated(user!);
  return user!;
}

/** First moment an account becomes usable: welcome the user, notify operations. */
function onActivated(user: Pick<UserRow, 'id' | 'email' | 'firstName'>) {
  void mailer.welcome({ to: user.email, firstName: user.firstName });
  void mailer.activity(user.id, 'Registration');
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

export interface RegistrationInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  gender: string;
  platform?: string;
  referredBy?: string;
}

/**
 * Step 1 of sign-up: creates the account in `pending_verification` and emails a
 * 5-digit code. No session is issued until the code is confirmed with
 * `verifyRegistration`. Registering again with an email that is still pending
 * replaces the earlier details (e.g. the user mistyped something and restarted).
 */
export async function register(input: RegistrationInput) {
  const passwordHash = await hashPassword(input.password);
  const existing = await findUserByEmail(input.email);

  if (existing && existing.registrationStatus === 'active') {
    throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  }

  if (existing) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(users)
        .set({
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          phoneNumber: input.phoneNumber,
          gender: input.gender,
          platform: input.platform ?? null,
        })
        .where(and(eq(users.id, existing.id), eq(users.registrationStatus, 'pending_verification')));
      // Verified by a concurrent request in the meantime.
      if (affectedRows(updated) === 0) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      await tx.delete(referrals).where(eq(referrals.userId, existing.id));
      if (input.referredBy) await attachReferral(tx, existing.id, input.referredBy);
    });
  } else {
    await createUser({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phoneNumber: input.phoneNumber,
      gender: input.gender,
      platform: input.platform,
      passwordHash,
      emailVerified: false,
      pendingVerification: true,
      referredBy: input.referredBy,
    });
  }

  await issueOtp(input.email, 'register');
  return pendingRegistrationResponse(input.email);
}

const pendingRegistrationResponse = (email: string) => ({
  email,
  status: 'pending_verification' as const,
  codeExpiresInSeconds: OTP_TTL_MS / 1000,
});

/** Step 2 of sign-up: confirms the emailed code, activates the account and signs the user in. */
export async function verifyRegistration(email: string, otp: string, client?: ClientInfo) {
  const user = await findUserByEmail(email);
  if (!user) throw badRequest('Invalid or expired verification code');
  if (user.registrationStatus === 'active') {
    throw conflict('ALREADY_VERIFIED', 'This account is already verified; please log in');
  }

  await consumeOtp(email, 'register', otp);
  await db
    .update(users)
    .set({ registrationStatus: 'active', emailVerifiedAt: new Date(), lastSeenAt: new Date() })
    .where(eq(users.id, user.id));
  onActivated(user);

  const active = { ...user, registrationStatus: 'active' as const };
  return { user: await loadMe(active), session: await issueSession(active, client?.userAgent) };
}

/** Sends a fresh sign-up code. Silent for unknown or already-verified emails (no enumeration). */
export async function resendRegistrationCode(email: string) {
  const user = await findUserByEmail(email);
  if (user?.registrationStatus !== 'pending_verification') return;
  await issueOtp(email, 'register');
}


export async function login(email: string, password: string, client?: ClientInfo) {
  const user = await findUserByEmail(email);
  if (!user) throw unauthorized('Invalid email or password');

  let ok = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
  if (!ok && user.legacyAuth) {
    // Lazy migration: the password may have been reset in Firebase after the data export.
    const firebaseUid = await verifyLegacyFirebasePassword(email, password);
    ok = firebaseUid === user.id;
  }
  if (!ok) throw unauthorized('Invalid email or password');
  // Checked after the password so the response doesn't reveal pending sign-ups to strangers.
  if (user.registrationStatus === 'pending_verification') {
    throw forbidden('Verify your email with the code we sent to finish signing up', 'EMAIL_NOT_VERIFIED');
  }

  if (user.legacyAuth || !user.passwordHash) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password), legacyAuth: false })
      .where(eq(users.id, user.id));
  }
  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  alertSignIn(user, client);
  return { user: await loadMe(user), session: await issueSession(user, client?.userAgent) };
}

/** Google / Apple sign-in: link by provider id, then by verified email, else create. */
export async function socialSignIn(
  identity: ExternalIdentity,
  extra: { firstName?: string; lastName?: string; referredBy?: string; platform?: string },
  client?: ClientInfo,
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
    if (user?.registrationStatus === 'pending_verification') {
      // The provider has proven ownership of this email. Whoever started the
      // unverified sign-up may not be the owner, so their password is discarded.
      await db
        .update(users)
        .set({ registrationStatus: 'active', emailVerifiedAt: new Date(), passwordHash: null })
        .where(eq(users.id, user.id));
      user = { ...user, registrationStatus: 'active', passwordHash: null };
      onActivated(user);
    }
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
  if (!isNewUser) alertSignIn(user, client);
  return { user: await loadMe(user), session: await issueSession(user, client?.userAgent), isNewUser };
}

// ─── Password reset: forgot → verify code → reset ───────────────────────────

/** Step 1: emails a 5-digit reset code. Silent for unknown emails (no enumeration). */
export async function forgotPassword(email: string) {
  if (!(await findUserByEmail(email))) return;
  await issueOtp(email, 'password_reset');
}

/**
 * Step 2: checks the emailed code and exchanges it for a single-use reset token,
 * so the app can confirm the code before asking for a new password. Issuing a
 * token invalidates any earlier unused ones for the same account.
 */
export async function verifyPasswordResetCode(email: string, otp: string) {
  const user = await findUserByEmail(email);
  if (!user) throw badRequest('Invalid or expired verification code');
  await consumeOtp(email, 'password_reset', otp);

  const resetToken = randomToken(32);
  await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({
      id: newId(),
      userId: user.id,
      tokenHash: sha256(resetToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    });
  });
  return { resetToken, expiresInSeconds: RESET_TOKEN_TTL_MS / 1000 };
}

/**
 * Step 3: sets the new password. The token is claimed with a conditional update,
 * so it works exactly once even under concurrent submissions. All sessions are
 * revoked; the user signs in again with the new password.
 */
export async function resetPassword(resetToken: string, newPassword: string) {
  const passwordHash = await hashPassword(newPassword);
  const tokenHash = sha256(resetToken);

  const user = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      );
    if (affectedRows(claimed) === 0) {
      throw badRequest('This reset link has expired or was already used; request a new code');
    }
    const [row] = await tx
      .select({ user: users })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.tokenHash, tokenHash));
    const owner = row!.user;
    await tx
      .update(users)
      .set({
        passwordHash,
        legacyAuth: false,
        // The reset code proved email ownership, which also completes a pending sign-up.
        registrationStatus: 'active',
        emailVerifiedAt: owner.emailVerifiedAt ?? new Date(),
      })
      .where(eq(users.id, owner.id));
    return owner;
  });

  if (user.registrationStatus === 'pending_verification') onActivated(user);
  await revokeAllSessions(user.id);
  void mailer.passwordChanged({ to: user.email, firstName: user.firstName });
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
  void mailer.passwordChanged({ to: user.email, firstName: user.firstName });
}
