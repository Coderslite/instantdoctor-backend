import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { otpCodes, passwordResetTokens, refreshTokens, users } from '../../src/db/schema/index.js';
import { mailer } from '../../src/integrations/mailer.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { api, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const EMAIL = 'patient@example.com';
const OLD = 'OldPassw0rd!';
const NEW = 'Br4ndNewPass!';

const login = (password: string) => api().post('/api/v1/auth/login').send({ email: EMAIL, password });
const forgot = (email = EMAIL) => api().post('/api/v1/auth/password/forgot').send({ email });
const verify = (otp: string, email = EMAIL) => api().post('/api/v1/auth/password/verify-code').send({ email, otp });
const reset = (resetToken: string, newPassword = NEW) =>
  api().post('/api/v1/auth/password/reset').send({ resetToken, newPassword });
/** Lets the next code be requested immediately (bypasses the 1/minute limit). */
const ageCodes = () => db.update(otpCodes).set({ createdAt: new Date(Date.now() - 120_000) });

describe('password reset: forgot → verify code → reset', () => {
  let codes: string[];

  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    codes = [];
    vi.spyOn(mailer, 'verificationCode').mockImplementation(async ({ code }) => {
      codes.push(code);
    });
    vi.spyOn(mailer, 'welcome').mockResolvedValue();
    await createUser({ email: EMAIL, passwordHash: await hashPassword(OLD) });
  });

  it('emails a code, exchanges it for a reset token, and sets the new password', async () => {
    expect((await forgot()).status).toBe(202);
    expect(codes).toHaveLength(1);

    const verified = await verify(codes[0]!);
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ resetToken: expect.any(String), expiresInSeconds: 900 });

    expect((await reset(verified.body.resetToken)).status).toBe(204);
    expect((await login(NEW)).status).toBe(200);
    expect((await login(OLD)).status).toBe(401);
  });

  it('responds the same for an unknown email and sends nothing', async () => {
    const res = await forgot('nobody@example.com');
    expect(res.status).toBe(202);
    expect(res.body).toEqual((await forgot()).body);
    expect(codes).toHaveLength(1); // only the real account got a code
  });

  it('rejects a wrong code, and locks the code after 5 wrong attempts', async () => {
    await forgot();
    const wrong = codes[0] === '11111' ? '22222' : '11111';
    for (let i = 0; i < 5; i++) expect((await verify(wrong)).status).toBe(400);
    expect((await verify(codes[0]!)).status).toBe(400);
  });

  it('rejects an expired code', async () => {
    await forgot();
    await db.update(otpCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await verify(codes[0]!)).status).toBe(400);
  });

  it('a code verifies only once', async () => {
    await forgot();
    expect((await verify(codes[0]!)).status).toBe(200);
    expect((await verify(codes[0]!)).status).toBe(400);
  });

  it('a reset token works only once, even under concurrent submissions', async () => {
    await forgot();
    const { resetToken } = (await verify(codes[0]!)).body;

    const results = await Promise.all([reset(resetToken, 'FirstChoice1!'), reset(resetToken, 'SecondChoice1!')]);

    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    expect((await reset(resetToken, 'ThirdChoice1!')).status).toBe(400);
  });

  it('rejects an expired reset token', async () => {
    await forgot();
    const { resetToken } = (await verify(codes[0]!)).body;
    await db.update(passwordResetTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await reset(resetToken)).status).toBe(400);
    expect((await login(OLD)).status).toBe(200);
  });

  it('verifying a newer code invalidates an earlier reset token', async () => {
    await forgot();
    const first = (await verify(codes[0]!)).body.resetToken;
    await ageCodes();
    await forgot();
    const second = (await verify(codes[1]!)).body.resetToken;

    expect((await reset(first)).status).toBe(400);
    expect((await reset(second)).status).toBe(204);
  });

  it('stores reset tokens hashed, never in plain text', async () => {
    await forgot();
    const { resetToken } = (await verify(codes[0]!)).body;
    const [row] = await db.select().from(passwordResetTokens);
    expect(row!.tokenHash).not.toBe(resetToken);
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the account out of every device', async () => {
    const session = (await login(OLD)).body.session;
    await forgot();
    await reset((await verify(codes[0]!)).body.resetToken);

    const refresh = await api().post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
    const live = (await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user!.id))).filter((t) => !t.revokedAt);
    expect(live).toHaveLength(0);
  });

  it('rate-limits reset codes to one per minute', async () => {
    await forgot();
    const res = await forgot();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OTP_RATE_LIMITED');
  });

  it('a sign-up code cannot be used to reset a password', async () => {
    await api().post('/api/v1/auth/register').send({
      email: 'pending@example.com',
      password: 'Sup3rSecret!',
      firstName: 'Ada',
      lastName: 'Obi',
      phoneNumber: '+2348012345678',
      gender: 'Female',
    });
    expect((await verify(codes[0]!, 'pending@example.com')).status).toBe(400);
  });

  it('works for migrated (legacy Firebase) accounts and clears the legacy flag', async () => {
    await db.update(users).set({ legacyAuth: true }).where(eq(users.email, EMAIL));
    await forgot();
    await reset((await verify(codes[0]!)).body.resetToken);
    const [user] = await db.select().from(users).where(eq(users.email, EMAIL));
    expect(user!.legacyAuth).toBe(false);
    expect((await login(NEW)).status).toBe(200);
  });
});
