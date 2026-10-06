import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, pharmacies, portalSessions } from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/ids.js';
import { api, auth, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const PASSWORD = 'Adm1nPassw0rd!';

describe('admin sessions', () => {
  beforeEach(async () => {
    await resetDatabase();
    await db.insert(admins).values({ id: newId(), name: 'Ops', email: 'ops@example.com', passwordHash: await hashPassword(PASSWORD) });
  });

  const login = async () => (await api().post('/api/v1/admin/auth/login').send({ email: 'ops@example.com', password: PASSWORD })).body.session;
  const refresh = (refreshToken: string) => api().post('/api/v1/admin/auth/refresh').send({ refreshToken });

  it('issues a refresh token that renews the session without signing in again', async () => {
    const session = await login();
    expect(session.refreshToken).toEqual(expect.any(String));

    const renewed = await refresh(session.refreshToken);
    expect(renewed.status).toBe(200);
    expect(renewed.body.session.refreshToken).not.toBe(session.refreshToken);
    expect((await api().get('/api/v1/admin/dashboard').set(auth(renewed.body.session.accessToken))).status).toBe(200);
  });

  it('lets two tabs refresh with the same token at the same moment', async () => {
    const session = await login();
    const results = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
  });

  it('treats a long-rotated token as stolen and ends the session family', async () => {
    const session = await login();
    const renewed = (await refresh(session.refreshToken)).body.session;
    await db.update(portalSessions).set({ rotatedAt: new Date(Date.now() - 60_000) });

    expect((await refresh(session.refreshToken)).status).toBe(401);
    expect((await refresh(renewed.refreshToken)).status).toBe(401);
  });

  it('logs out', async () => {
    const session = await login();
    expect((await api().post('/api/v1/admin/auth/logout').send({ refreshToken: session.refreshToken })).status).toBe(204);
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });

  it('rejects an expired refresh token', async () => {
    const session = await login();
    await db.update(portalSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });
});

describe('pharmacy sessions', () => {
  let pharmacyId: string;

  beforeEach(async () => {
    await resetDatabase();
    pharmacyId = newId();
    await db.insert(pharmacies).values({ id: pharmacyId, name: 'Medplus', email: 'store@example.com', passwordHash: await hashPassword(PASSWORD) });
  });

  const login = async () => (await api().post('/api/v1/pharmacy-portal/auth/login').send({ email: 'store@example.com', password: PASSWORD })).body.session;
  const refresh = (refreshToken: string) => api().post('/api/v1/pharmacy-portal/auth/refresh').send({ refreshToken });

  it('renews the session', async () => {
    const session = await login();
    const renewed = await refresh(session.refreshToken);
    expect(renewed.status).toBe(200);
    expect(renewed.body.session.accessToken).toEqual(expect.any(String));
  });

  it('does not accept an admin refresh token', async () => {
    await db.insert(admins).values({ id: newId(), name: 'Ops', email: 'ops@example.com', passwordHash: await hashPassword(PASSWORD) });
    const admin = (await api().post('/api/v1/admin/auth/login').send({ email: 'ops@example.com', password: PASSWORD })).body.session;
    expect((await refresh(admin.refreshToken)).status).toBe(401);
  });

  it('ends sessions when the pharmacy is suspended', async () => {
    const session = await login();
    await db.update(pharmacies).set({ status: 'suspended' });
    expect((await refresh(session.refreshToken)).status).toBe(401);
  });

  it('changing the password signs out other devices and keeps this one', async () => {
    const other = await login();
    const current = await login();
    const changed = await api()
      .patch('/api/v1/pharmacy-portal/password')
      .set(auth(current.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'N3wPharmacyPass!' });
    expect(changed.status).toBe(200);
    expect((await refresh(other.refreshToken)).status).toBe(401);
    expect((await refresh(changed.body.session.refreshToken)).status).toBe(200);
  });
});
