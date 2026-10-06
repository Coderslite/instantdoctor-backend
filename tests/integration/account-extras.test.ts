import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { payoutAccounts, referrals, users } from '../../src/db/schema/index.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

describe('payout account', () => {
  beforeEach(() => resetDatabase());

  const account = { bankName: 'Access Bank', accountNumber: '0123456789', accountName: 'ADA OBI' };

  it('is 404 until saved, then round-trips', async () => {
    const user = await createUser();
    expect((await api().get('/api/v1/users/me/payout-account').set(auth(user.token))).status).toBe(404);

    const saved = await api().put('/api/v1/users/me/payout-account').set(auth(user.token)).send(account);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ...account, bankCode: null });

    const got = await api().get('/api/v1/users/me/payout-account').set(auth(user.token));
    expect(got.body).toMatchObject(account);
  });

  it('replaces details and clears the stale provider recipient code', async () => {
    const user = await createUser();
    await api().put('/api/v1/users/me/payout-account').set(auth(user.token)).send(account);
    await db.update(payoutAccounts).set({ recipientCode: 'RCP_old' }).where(eq(payoutAccounts.userId, user.id));

    await api()
      .put('/api/v1/users/me/payout-account')
      .set(auth(user.token))
      .send({ ...account, accountNumber: '9876543210', bankCode: '058' });

    const [row] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, user.id));
    expect(row).toMatchObject({ accountNumber: '9876543210', bankCode: '058', recipientCode: null });
  });

  it('validates the account number', async () => {
    const user = await createUser();
    const res = await api()
      .put('/api/v1/users/me/payout-account')
      .set(auth(user.token))
      .send({ ...account, accountNumber: '12ab' });
    expect(res.status).toBe(400);
  });

  it('deletes', async () => {
    const user = await createUser();
    await api().put('/api/v1/users/me/payout-account').set(auth(user.token)).send(account);
    expect((await api().delete('/api/v1/users/me/payout-account').set(auth(user.token))).status).toBe(204);
    expect((await api().get('/api/v1/users/me/payout-account').set(auth(user.token))).status).toBe(404);
  });

  it('is private to each user', async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);
    await api().put('/api/v1/users/me/payout-account').set(auth(a.token)).send(account);
    expect((await api().get('/api/v1/users/me/payout-account').set(auth(b.token))).status).toBe(404);
  });
});

describe('referral code after sign-up', () => {
  beforeEach(() => resetDatabase());

  const apply = (token: string, code: string) => api().post('/api/v1/users/me/referral').set(auth(token)).send({ code });

  it('lets a new user apply a code once', async () => {
    const referrer = await createUser({ tag: 'friend01' });
    const user = await createUser();

    expect((await api().get('/api/v1/users/me/referral').set(auth(user.token))).body).toMatchObject({
      referredBy: null,
      canApplyCode: true,
    });
    const res = await apply(user.token, 'FRIEND01'); // codes are case-insensitive
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ referredBy: 'friend01', canApplyCode: false });

    const [row] = await db.select().from(referrals).where(eq(referrals.userId, user.id));
    expect(row!.referrerId).toBe(referrer.id);
    expect((await apply(user.token, 'friend01')).body.error.code).toBe('ALREADY_REFERRED');
  });

  it('only one of two concurrent applications wins', async () => {
    await createUser({ tag: 'friend01' });
    await createUser({ tag: 'friend02' });
    const user = await createUser();
    const results = await Promise.all([apply(user.token, 'friend01'), apply(user.token, 'friend02')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.select().from(referrals).where(eq(referrals.userId, user.id))).toHaveLength(1);
  });

  it('rejects unknown and self codes', async () => {
    const user = await createUser({ tag: 'me0001' });
    expect((await apply(user.token, 'nobody99')).status).toBe(400);
    expect((await apply(user.token, 'me0001')).status).toBe(400);
  });

  it('closes after the 7-day window', async () => {
    await createUser({ tag: 'friend01' });
    const user = await createUser({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    const res = await apply(user.token, 'friend01');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFERRAL_WINDOW_CLOSED');
  });

  it('closes after the first paid consultation', async () => {
    await createUser({ tag: 'friend01' });
    const user = await createUser();
    await db.update(users).set({ hasPaid: true }).where(eq(users.id, user.id));
    expect((await apply(user.token, 'friend01')).body.error.code).toBe('REFERRAL_WINDOW_CLOSED');
  });
});
