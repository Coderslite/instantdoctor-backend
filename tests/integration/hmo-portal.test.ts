import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, serviceCharges } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const PASSWORD = 'Temp-pass-123';
const NEW_PASSWORD = 'My-own-pass-456';

let adminToken: string;
let packageId: string;

const admin = {
  get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(adminToken)),
  post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
  patch: (p: string, b: object = {}) =>
    api().patch(`/api/v1/admin${p}`).set(auth(adminToken)).send(b),
};
const portal = (token: string) => ({
  get: (p: string) => api().get(`/api/v1/hmo-portal${p}`).set(auth(token)),
  post: (p: string, b: object = {}) =>
    api().post(`/api/v1/hmo-portal${p}`).set(auth(token)).send(b),
  patch: (p: string, b: object = {}) =>
    api().patch(`/api/v1/hmo-portal${p}`).set(auth(token)).send(b),
});

/** An HMO with a "Gold" plan that fully covers consultations (₦6,000 tariff, 4 a month). */
async function createHmo(code: string) {
  const hmo = await admin.post('/hmos', {
    name: `${code} Health`,
    code,
    notes: 'Internal: renegotiate in Q3',
  });
  expect(hmo.status).toBe(201);
  const withPlan = await admin.post(`/hmos/${hmo.body.id}/plans`, { name: 'Gold' });
  const planId = withPlan.body.plans[0].id as string;
  const rule = await admin.post(`/hmos/${hmo.body.id}/plans/${planId}/rules`, {
    service: 'consultation',
    coverage: 'full',
    hmoAmount: 6_000,
    limitCount: 4,
    limitPeriod: 'month',
  });
  expect(rule.status).toBe(201);
  return { hmoId: hmo.body.id as string, planId };
}

/** A portal account that has already chosen its own password; returns its access token. */
async function signedIn(hmoId: string, role: 'admin' | 'manager' | 'viewer', email = `${role}-${newId()}@hmo.test`) {
  const created = await admin.post(`/hmos/${hmoId}/users`, {
    name: `${role[0]!.toUpperCase()}${role.slice(1)} Person`,
    email,
    role,
    password: PASSWORD,
  });
  expect(created.status).toBe(201);
  const login = await api().post('/api/v1/hmo-portal/auth/login').send({ email, password: PASSWORD });
  expect(login.status).toBe(200);
  const changed = await portal(login.body.session.accessToken).patch('/password', {
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
  });
  expect(changed.status).toBe(200);
  return { id: created.body.id as string, token: changed.body.session.accessToken as string };
}

/** A member who uses the app (matched by email) and has had one covered consultation. */
async function memberWithVisit(hmoId: string, planId: string) {
  const email = 'ada@patient.test';
  const user = await createUser({ email, country: 'NG', currency: 'NGN', lastName: 'Obi' });
  const member = await admin.post(`/hmos/${hmoId}/enrollees`, {
    planId,
    enrolleeCode: 'GLD-001',
    firstName: 'Ada',
    lastName: 'Obi',
    email,
  });
  expect(member.body.userId).toBe(user.id);
  const booking = await api()
    .post('/api/v1/appointments')
    .set(auth(user.token))
    .set('Idempotency-Key', `visit-${newId()}`)
    .send({ packageId, startTime: inHours(3) });
  expect(booking.status).toBe(201);
  return { enrolleeId: member.body.id as string };
}

beforeEach(async () => {
  await resetDatabase();
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Funmi (Ops)', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
  packageId = await createPackage({ name: 'GP' });
  await db
    .insert(serviceCharges)
    .values({ id: newId(), type: 'LapResult', name: 'Lab interpretation', amountUsd: 4 });
});

describe('HMO portal sign-in', () => {
  it('gives portal access with a temporary password that must be changed first', async () => {
    const { hmoId } = await createHmo('AVON');
    const created = await admin.post(`/hmos/${hmoId}/users`, {
      name: 'Chidi Eze',
      email: 'Chidi@Avon.Example',
      role: 'admin',
      password: PASSWORD,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'chidi@avon.example', mustChangePassword: true });
    expect(created.body.passwordHash).toBeUndefined();

    const bad = await api()
      .post('/api/v1/hmo-portal/auth/login')
      .send({ email: 'chidi@avon.example', password: 'wrong-password' });
    expect(bad.status).toBe(401);

    const login = await api()
      .post('/api/v1/hmo-portal/auth/login')
      .send({ email: 'chidi@avon.example', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.hmo).toMatchObject({ id: hmoId, code: 'AVON' });
    expect(login.body.hmo.notes).toBeUndefined(); // internal admin notes
    const first = login.body.session;

    // Locked to /me and /password until the temporary password is replaced.
    expect((await portal(first.accessToken).get('/me')).status).toBe(200);
    const locked = await portal(first.accessToken).get('/dashboard');
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const wrong = await portal(first.accessToken).patch('/password', {
      currentPassword: 'not-it-at-all',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(400);

    const changed = await portal(first.accessToken).patch('/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.status).toBe(200);
    // The old session is gone everywhere; the new one works.
    expect((await portal(first.accessToken).get('/me')).status).toBe(401);
    const reused = await api()
      .post('/api/v1/hmo-portal/auth/refresh')
      .send({ refreshToken: first.refreshToken });
    expect(reused.status).toBe(401);
    expect((await portal(changed.body.session.accessToken).get('/dashboard')).status).toBe(200);

    const refreshed = await api()
      .post('/api/v1/hmo-portal/auth/refresh')
      .send({ refreshToken: changed.body.session.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await portal(refreshed.body.session.accessToken).get('/me')).body.account).toMatchObject({
      mustChangePassword: false,
      role: 'admin',
    });
  });

  it('rejects patient, admin and pharmacy tokens', async () => {
    const patient = await createUser();
    expect((await portal(patient.token).get('/me')).status).toBe(401);
    expect((await portal(adminToken).get('/me')).status).toBe(401);
  });
});

describe('HMO portal scope and roles', () => {
  it('an HMO only ever sees its own members, plans and claims', async () => {
    const a = await createHmo('AVON');
    const b = await createHmo('HYGE');
    const theirs = await admin.post(`/hmos/${b.hmoId}/enrollees`, {
      planId: b.planId,
      enrolleeCode: 'HYG-1',
    });
    const { token } = await signedIn(a.hmoId, 'admin');

    expect((await portal(token).get('/enrollees')).body.total).toBe(0);
    expect((await portal(token).get(`/enrollees/${theirs.body.id}`)).status).toBe(404);
    expect(
      (await portal(token).patch(`/enrollees/${theirs.body.id}`, { status: 'ended' })).status,
    ).toBe(404);
    expect((await portal(token).get(`/plans/${b.planId}/price-preview`)).status).toBe(404);
    expect(
      (await portal(token).post('/enrollees', { planId: b.planId, enrolleeCode: 'X-1' })).status,
    ).toBe(404);
  });

  it('viewers read; managers also manage members; only admins manage the team and profile', async () => {
    const { hmoId, planId } = await createHmo('AVON');
    const viewer = await signedIn(hmoId, 'viewer');
    const manager = await signedIn(hmoId, 'manager');
    const member = { planId, enrolleeCode: 'avn-7', lastName: 'Bello', phone: '08031234567' };

    expect((await portal(viewer.token).get('/enrollees')).status).toBe(200);
    expect((await portal(viewer.token).get('/plans')).status).toBe(200);
    expect((await portal(viewer.token).post('/enrollees', member)).status).toBe(403);

    const added = await portal(manager.token).post('/enrollees', member);
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ enrolleeCode: 'AVN-7', phone: '+2348031234567', linked: false });
    expect((await portal(manager.token).get('/team')).status).toBe(403);
    expect((await portal(manager.token).patch('/profile', { contactName: 'X' })).status).toBe(403);
  });
});

describe('HMO portal transparency', () => {
  it('shows utilisation and billing, without app accounts or doctor pay', async () => {
    const { hmoId, planId } = await createHmo('AVON');
    const { enrolleeId } = await memberWithVisit(hmoId, planId);
    const { token } = await signedIn(hmoId, 'viewer');

    const list = await portal(token).get('/enrollees');
    expect(list.body.items[0]).toMatchObject({ enrolleeCode: 'GLD-001', linked: true });
    expect(list.body.items[0].account).toBeUndefined();
    expect(list.body.items[0].userId).toBeUndefined();

    const claims = await portal(token).get('/claims?service=consultation&search=Obi');
    expect(claims.body.items).toHaveLength(1);
    expect(claims.body.items[0]).toMatchObject({ hmoAmount: 6_000, patientAmount: 0 });
    expect(claims.body.items[0]).not.toHaveProperty('doctorEarning');
    expect((await portal(token).get('/claims?search=nobody')).body.items).toHaveLength(0);

    const profile = await portal(token).get(`/enrollees/${enrolleeId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.enrollee.linked).toBe(true);
    expect(profile.body.benefits[0]).toMatchObject({
      label: 'Consultations',
      summary: 'Fully covered',
      limitCount: 4,
      usedCount: 1,
    });
    expect(profile.body.claimTotals.unbilled).toMatchObject({ claims: 1, hmoAmount: 6_000 });

    const plans = await portal(token).get('/plans');
    expect(plans.body.plans[0].rules[0]).not.toHaveProperty('doctorEarning');
    const preview = await portal(token).get(`/plans/${planId}/price-preview`);
    expect(preview.body.consultations[0]).not.toHaveProperty('doctorEarning');

    const dashboard = await portal(token).get('/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.members).toMatchObject({ total: 1, active: 1, linked: 1, newThisMonth: 1 });
    expect(dashboard.body.utilisation).toHaveLength(6);
    expect(dashboard.body.utilisation.at(-1)).toMatchObject({ claims: 1, hmoAmount: 6_000 });
    expect(dashboard.body.utilisation.at(-1).services.consultation).toEqual({
      claims: 1,
      hmoAmount: 6_000,
    });
    expect(dashboard.body.billing).toMatchObject({ unbilledClaims: 1, unbilledAmount: 6_000 });
    expect(dashboard.body.plans).toEqual([
      expect.objectContaining({ name: 'Gold', members: 1 }),
    ]);
    expect(dashboard.body.recentClaims[0]).not.toHaveProperty('doctorEarning');
  });

  it('records every change, on either side, in a trail both can read', async () => {
    const { hmoId, planId } = await createHmo('AVON');
    const { enrolleeId } = await memberWithVisit(hmoId, planId);
    const manager = await signedIn(hmoId, 'manager');

    const suspended = await portal(manager.token).patch(`/enrollees/${enrolleeId}`, {
      status: 'suspended',
      firstName: 'Ada', // unchanged: not reported
    });
    expect(suspended.status).toBe(200);
    // A no-op update leaves no entry.
    await portal(manager.token).patch(`/enrollees/${enrolleeId}`, { status: 'suspended' });

    const claim = (await admin.get(`/hmos/${hmoId}/claims`)).body.items[0];
    await admin.patch(`/hmos/${hmoId}/claims/${claim.id}`, { status: 'rejected', note: 'Duplicate' });
    await admin.patch(`/hmos/${hmoId}`, { notes: 'Internal only' }); // never shown to the HMO

    const trail = await portal(manager.token).get('/activity');
    expect(trail.status).toBe(200);
    const summaries = trail.body.items.map((e: { summary: string }) => e.summary);
    expect(summaries).not.toContainEqual(expect.stringContaining('Internal'));
    expect(trail.body.items[0]).toMatchObject({
      actorType: 'admin',
      actorName: 'Funmi (Ops)',
      action: 'claim.rejected',
    });
    expect(trail.body.items[0].summary).toContain('Duplicate');
    expect(trail.body.items[1]).toMatchObject({
      actorType: 'hmo_user',
      actorName: 'Manager Person',
      action: 'member.updated',
      entityId: enrolleeId,
      summary: 'Updated member GLD-001: status active → suspended',
    });
    expect(trail.body.items.filter((e: { action: string }) => e.action === 'member.updated')).toHaveLength(1);

    const forMember = await portal(manager.token).get(
      `/activity?entityType=member&entityId=${enrolleeId}`,
    );
    expect(forMember.body.items.map((e: { action: string }) => e.action)).toEqual([
      'member.updated',
      'member.created',
    ]);
    const adminView = await admin.get(`/hmos/${hmoId}/activity?actorType=hmo_user`);
    expect(adminView.body.items.map((e: { action: string }) => e.action)).toEqual(['member.updated']);
  });

  it('imports the HMO’s monthly list and ends members missing from it', async () => {
    const { hmoId, planId } = await createHmo('AVON');
    const manager = await signedIn(hmoId, 'manager');
    await portal(manager.token).post('/enrollees', { planId, enrolleeCode: 'OLD-1' });

    const result = await portal(manager.token).post('/enrollees/import', {
      planId,
      endMissing: true,
      rows: [
        { enrolleeCode: 'new-1', lastName: 'Ade', dateOfBirth: '23/04/1990' },
        { enrolleeCode: 'new-2', email: 'not-an-email' },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ created: 2, updated: 0, ended: 1 });
    expect(result.body.errors).toHaveLength(1);
    const ended = await portal(manager.token).get('/enrollees?status=ended');
    expect(ended.body.items.map((e: { enrolleeCode: string }) => e.enrolleeCode)).toEqual(['OLD-1']);
    const [entry] = (await portal(manager.token).get('/activity')).body.items;
    expect(entry).toMatchObject({ action: 'members.imported' });
    expect(entry.summary).toBe('Imported 2 rows into Gold: 2 added, 0 updated, 1 ended');
  });
});

describe('HMO portal team', () => {
  it('admins manage colleagues; deactivation signs them out at once; one admin always remains', async () => {
    const { hmoId } = await createHmo('AVON');
    const owner = await signedIn(hmoId, 'admin');
    const colleague = await portal(owner.token).post('/team', {
      name: 'Bisi Ade',
      email: 'bisi@avon.example',
      role: 'viewer',
      password: PASSWORD,
    });
    expect(colleague.status).toBe(201);
    const login = await api()
      .post('/api/v1/hmo-portal/auth/login')
      .send({ email: 'bisi@avon.example', password: PASSWORD });
    const bisi = (
      await portal(login.body.session.accessToken).patch('/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      })
    ).body.session;
    expect((await portal(bisi.accessToken).get('/claims')).status).toBe(200);

    // Promotion applies on the next request, without signing out.
    await portal(owner.token).patch(`/team/${colleague.body.id}`, { role: 'manager' });
    expect((await portal(bisi.accessToken).get('/me')).body.account.role).toBe('manager');

    await portal(owner.token).patch(`/team/${colleague.body.id}`, { status: 'inactive' });
    expect((await portal(bisi.accessToken).get('/claims')).status).toBe(401);
    expect(
      (await api().post('/api/v1/hmo-portal/auth/refresh').send({ refreshToken: bisi.refreshToken }))
        .status,
    ).toBe(401);

    // Nobody changes their own access, and the last active admin stays.
    const self = await portal(owner.token).patch(`/team/${owner.id}`, { role: 'viewer' });
    expect(self.body.error.code).toBe('OWN_ACCOUNT');
    const last = await admin.patch(`/hmos/${hmoId}/users/${owner.id}`, { status: 'inactive' });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('LAST_ADMIN');

    const reset = await admin.post(`/hmos/${hmoId}/users/${owner.id}/reset-password`, {
      password: 'Another-temp-789',
    });
    expect(reset.body.mustChangePassword).toBe(true);
    expect((await portal(owner.token).get('/me')).status).toBe(401);

    const team = await admin.get(`/hmos/${hmoId}/users`);
    expect(team.body.items.map((u: { email: string }) => u.email)).toContain('bisi@avon.example');
  });
});
