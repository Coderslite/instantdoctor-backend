import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { otpCodes, referrals, users } from '../../src/db/schema/index.js';
import { mailer } from '../../src/integrations/mailer.js';
import { socialSignIn } from '../../src/modules/auth/auth.service.js';
import { api, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const EMAIL = 'new.patient@example.com';
const signup = (overrides: Record<string, unknown> = {}) => ({
  email: EMAIL,
  password: 'Sup3rSecret!',
  firstName: 'Ada',
  lastName: 'Obi',
  phoneNumber: '+2348012345678',
  gender: 'Female',
  ...overrides,
});

/** Captures codes "emailed" by the mail client. */
function captureOtps() {
  const sent: string[] = [];
  vi.spyOn(mailer, 'verificationCode').mockImplementation(async ({ code }) => {
      sent.push(code);
    });
  vi.spyOn(mailer, 'welcome').mockResolvedValue();
  return sent;
}

/** Lets the next code be requested immediately (bypasses the 1/minute limit). */
const ageCodes = () => db.update(otpCodes).set({ createdAt: new Date(Date.now() - 120_000) });

describe('sign-up: register then verify', () => {
  let codes: string[];

  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    codes = captureOtps();
  });

  it('register creates a pending account, emails a code, and returns no session', async () => {
    const res = await api().post('/api/v1/auth/register').send(signup());

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email: EMAIL, status: 'pending_verification', codeExpiresInSeconds: 600 });
    expect(res.body.session).toBeUndefined();
    expect(codes).toHaveLength(1);
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(user).toMatchObject({ registrationStatus: 'pending_verification', emailVerifiedAt: null });
    expect(mailer.welcome).not.toHaveBeenCalled();
  });

  it('verify activates the account and signs the user in', async () => {
    await api().post('/api/v1/auth/register').send(signup());

    const res = await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[0] });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.session.accessToken).toBeTruthy();
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(user!.registrationStatus).toBe('active');
    expect(user!.emailVerifiedAt).not.toBeNull();
    expect(mailer.welcome).toHaveBeenCalledOnce();

    // The account now logs in normally, and the code cannot be replayed.
    expect((await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'Sup3rSecret!' })).status).toBe(200);
    const replay = await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[0] });
    expect(replay.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('rejects a wrong code and locks the code after 5 wrong attempts', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    const wrong = codes[0] === '11111' ? '22222' : '11111';

    for (let i = 0; i < 5; i++) {
      expect((await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: wrong })).status).toBe(400);
    }
    const res = await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[0] });
    expect(res.status).toBe(400);
  });

  it('blocks login until the email is verified', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    const res = await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'Sup3rSecret!' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('does not reveal a pending sign-up to someone with the wrong password', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    const res = await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'WrongPassword1' });
    expect(res.status).toBe(401);
  });

  it('resend issues a new code that verifies; the old code no longer works', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    await ageCodes();

    const resend = await api().post('/api/v1/auth/register/resend').send({ email: EMAIL });
    expect(resend.status).toBe(202);
    expect(codes).toHaveLength(2);
    if (codes[0] !== codes[1]) {
      expect((await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[0] })).status).toBe(400);
    }
    expect((await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[1] })).status).toBe(200);
  });

  it('rate-limits codes to one per minute', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    const res = await api().post('/api/v1/auth/register/resend').send({ email: EMAIL });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
  });

  it('resend is silent for unknown and already-verified emails', async () => {
    const verified = await createUser({ email: 'verified@example.com' });
    expect(verified).toBeTruthy();
    for (const email of ['nobody@example.com', 'verified@example.com']) {
      expect((await api().post('/api/v1/auth/register/resend').send({ email })).status).toBe(202);
    }
    expect(codes).toHaveLength(0);
  });

  it('re-registering a pending email replaces the details instead of failing', async () => {
    const referrer = await createUser({ tag: 'friend01' });
    await api().post('/api/v1/auth/register').send(signup({ firstName: 'Typo', referredBy: 'friend01' }));
    await ageCodes();

    const res = await api().post('/api/v1/auth/register').send(signup({ firstName: 'Ada', password: 'NewPassw0rd!' }));
    expect(res.status).toBe(201);

    await api().post('/api/v1/auth/register/verify').send({ email: EMAIL, otp: codes[1] });
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(user!.firstName).toBe('Ada');
    expect((await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'NewPassw0rd!' })).status).toBe(200);
    // The second registration had no referral code, so the first one's is dropped.
    expect(await db.select().from(referrals).where(eq(referrals.referrerId, referrer.id))).toHaveLength(0);
  });

  it('refuses to register an email that already has a verified account', async () => {
    await createUser({ email: EMAIL });
    const res = await api().post('/api/v1/auth/register').send(signup());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
    expect(codes).toHaveLength(0);
  });

  it('check-email reports a pending sign-up as available', async () => {
    await api().post('/api/v1/auth/register').send(signup());
    const res = await api().post('/api/v1/auth/check-email').send({ email: EMAIL });
    expect(res.body.available).toBe(true);
  });

  it('a Google sign-in with the same email takes over a pending sign-up and discards its password', async () => {
    // Someone (maybe not the owner) starts a sign-up with this email and never verifies.
    await api().post('/api/v1/auth/register').send(signup({ password: 'AttackerPass1' }));

    const result = await socialSignIn(
      { provider: 'google', providerUserId: 'google-owner', email: EMAIL, emailVerified: true },
      {},
    );

    expect(result.isNewUser).toBe(false);
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(user).toMatchObject({ registrationStatus: 'active', passwordHash: null });
    expect((await api().post('/api/v1/auth/login').send({ email: EMAIL, password: 'AttackerPass1' })).status).toBe(401);
  });

  it('the standalone /auth/otp endpoint is gone', async () => {
    const res = await api().post('/api/v1/auth/otp').send({ email: EMAIL, purpose: 'register' });
    expect(res.status).toBe(404);
  });
});
