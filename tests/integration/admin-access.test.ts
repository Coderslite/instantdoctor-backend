import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import type { AdminRole } from '../../src/db/schema/index.js';
import { adminToken, api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(token)),
  post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(token)).send(b),
  patch: (p: string, b: object = {}) => api().patch(`/api/v1/admin${p}`).set(auth(token)).send(b),
  put: (p: string, b: object = {}) => api().put(`/api/v1/admin${p}`).set(auth(token)).send(b),
});

describe('admin roles', () => {
  let outbox: OutgoingMail[];
  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    setMailSink(async (mail) => {
      outbox.push(mail);
    });
  });
  afterEach(() => setMailSink(undefined));

  it('each role reaches only its areas; reads need view and changes need manage', async () => {
    const patient = await createUser({ firstName: 'Ada', email: 'ada@patient.test' });
    const tokens = Object.fromEntries(
      await Promise.all((['admin', 'operations', 'finance', 'clinical', 'support', 'marketer'] as AdminRole[]).map(async (r) => [r, await adminToken(r)])),
    ) as Record<AdminRole, string>;
    const status = async (role: AdminRole, method: 'get' | 'post' | 'patch' | 'put', path: string, body: object = {}) =>
      (method === 'get' ? await as(tokens[role]).get(path) : await as(tokens[role])[method](path, body)).status;

    // Marketing: blog, mail and recipients' names; never patient records or money.
    expect(await status('marketer', 'get', '/blog/posts')).toBe(200);
    expect(await status('marketer', 'get', '/patients?search=ada')).toBe(200);
    expect(await status('marketer', 'get', `/patients/${patient.id}`)).toBe(403);
    expect(await status('marketer', 'get', '/revenue?from=2026-01-01&to=2026-01-31')).toBe(403);
    expect(await status('marketer', 'get', '/hmos')).toBe(403);
    expect(await status('marketer', 'get', '/team')).toBe(403);
    // The overview has no money for them.
    const overview = await as(tokens.marketer).get('/dashboard');
    expect(overview.status).toBe(200);
    expect(overview.body.patients).toBe(1);
    expect(overview.body.platformEarnings).toBeUndefined();

    // Finance: manages money and HMO billing; sees patients and appointments; can't change them.
    expect(await status('finance', 'get', '/revenue?from=2026-01-01&to=2026-01-31')).toBe(200);
    expect(await status('finance', 'get', '/payouts/overview')).toBe(200);
    expect(await status('finance', 'get', `/patients/${patient.id}`)).toBe(200);
    expect(await status('finance', 'patch', `/patients/${patient.id}`, { firstName: 'X' })).toBe(403);
    expect(await status('finance', 'get', '/blog/posts')).toBe(403);
    expect((await as(tokens.finance).get('/dashboard')).body.platformEarnings).toBe(0);

    // Operations: run the service, see finance but not change fees or the team.
    expect(await status('operations', 'patch', `/patients/${patient.id}`, { firstName: 'Adaeze' })).toBe(200);
    expect(await status('operations', 'get', '/payouts/overview')).toBe(200);
    expect(await status('operations', 'post', '/payouts/run-weekly')).toBe(403);
    expect(await status('operations', 'get', '/commercial-fees')).toBe(200);
    expect(await status('operations', 'put', '/commercial-fees', {})).toBe(403);

    // Clinical: doctors, lab results and the review queue; patients read-only.
    expect(await status('clinical', 'get', '/doctor-applications')).toBe(200);
    expect(await status('clinical', 'get', '/lab-results')).toBe(200);
    expect(await status('clinical', 'patch', `/patients/${patient.id}`, { firstName: 'X' })).toBe(403);
    expect(await status('clinical', 'get', '/payments')).toBe(403);

    // Support: patients and appointments; can't see money or change pharmacies.
    expect(await status('support', 'get', `/patients/${patient.id}`)).toBe(200);
    expect(await status('support', 'get', '/orders')).toBe(200);
    expect(await status('support', 'post', '/product-categories', { name: 'X' })).toBe(403);
    expect(await status('support', 'get', '/payments')).toBe(403);

    // Admin: everything.
    expect(await status('admin', 'get', '/team')).toBe(200);
    expect((await as(tokens.admin).get('/me')).body).toMatchObject({ role: 'admin', permissions: { team: 'manage', finance: 'manage' } });
    expect((await as(tokens.marketer).get('/me')).body).toMatchObject({ role: 'marketer', permissions: { blog: 'manage', mail: 'manage' } });
    expect((await as(tokens.marketer).get('/me')).body.permissions.patients).toBeUndefined();
  });

  it('invites a colleague who must choose a password; role changes and deactivation apply at once', async () => {
    const owner = await adminToken('admin');
    const invited = await as(owner).post('/team', { name: 'Tolu Ade', email: 'Tolu@InstantDoctor.test', role: 'support' });
    expect(invited.status).toBe(201);
    expect(invited.body.admin).toMatchObject({ email: 'tolu@instantdoctor.test', role: 'support', roleLabel: 'Support', mustChangePassword: true, status: 'active' });
    const password = invited.body.temporaryPassword as string;
    await new Promise((r) => setTimeout(r, 100));
    const mail = outbox.find((m) => m.category === 'admin-invited')!;
    expect(mail.to).toBe('tolu@instantdoctor.test');
    expect(mail.text).toContain(password);
    expect((await as(owner).post('/team', { name: 'Again', email: 'tolu@instantdoctor.test', role: 'finance' })).body.error.code).toBe('EMAIL_TAKEN');

    // Temporary password: only their account is open until they change it.
    const login = await api().post('/api/v1/admin/auth/login').send({ email: 'tolu@instantdoctor.test', password });
    expect(login.body.admin).toMatchObject({ role: 'support', mustChangePassword: true, permissions: { patients: 'manage' } });
    const first = login.body.session.accessToken as string;
    expect((await as(first).get('/me')).status).toBe(200);
    expect((await as(first).get('/patients')).status).toBe(403);
    const changed = await as(first).patch('/me/password', { currentPassword: password, newPassword: 'Tolu-own-pass-2026' });
    expect(changed.status).toBe(200);
    const tolu = changed.body.session.accessToken as string;
    expect((await as(tolu).get('/patients')).status).toBe(200);
    expect((await as(tolu).get('/payments')).status).toBe(403);

    // Promoted to finance: the same token now opens payments.
    const id = invited.body.admin.id as string;
    expect((await as(owner).patch(`/team/${id}`, { role: 'finance' })).body.role).toBe('finance');
    expect((await as(tolu).get('/payments')).status).toBe(200);

    // Deactivated: locked out immediately, and can't sign in.
    await as(owner).patch(`/team/${id}`, { status: 'inactive' });
    expect((await as(tolu).get('/payments')).status).toBe(401);
    expect((await api().post('/api/v1/admin/auth/login').send({ email: 'tolu@instantdoctor.test', password: 'Tolu-own-pass-2026' })).status).toBe(403);
    expect((await as(tolu).get('/team')).status).toBe(401);

    // A reset emails a fresh temporary password.
    await as(owner).patch(`/team/${id}`, { status: 'active' });
    const reset = await as(owner).post(`/team/${id}/reset-password`);
    expect(reset.body.temporaryPassword).toHaveLength(12);
    expect((await api().post('/api/v1/admin/auth/login').send({ email: 'tolu@instantdoctor.test', password: reset.body.temporaryPassword })).body.admin.mustChangePassword).toBe(true);
  });

  it('admins can’t change their own role or switch themselves off; another admin can', async () => {
    const owner = await adminToken('admin');
    const ownerId = (await as(owner).get('/me')).body.id as string;
    expect((await as(owner).patch(`/team/${ownerId}`, { role: 'support' })).status).toBe(400);
    expect((await as(owner).patch(`/team/${ownerId}`, { status: 'inactive' })).status).toBe(400);
    const other = await adminToken('admin');
    expect((await as(other).patch(`/team/${ownerId}`, { role: 'operations' })).body.role).toBe('operations');
    // Now operations: the team is closed to them.
    expect((await as(owner).get('/team')).status).toBe(403);
    expect((await as(owner).get('/appointments')).status).toBe(200);
  });
});
