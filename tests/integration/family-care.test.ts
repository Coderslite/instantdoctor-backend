import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { carePlans, careSummaryShares } from '../../src/db/schema/index.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const addProfile = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post('/api/v1/family-profiles')
    .set(auth(token))
    .send({ name: 'Mum', relationship: 'parent', dateOfBirth: '1960-04-12', allergies: 'Penicillin', ...body });

const tokenOf = (url: string) => url.split('/care-summaries/')[1]!;

describe('family profiles', () => {
  beforeEach(() => resetDatabase());

  it('creates, lists, updates and deletes a family member', async () => {
    const user = await createUser();
    const created = await addProfile(user.token);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Mum', relationship: 'parent', allergies: 'Penicillin', caregiverReminders: true });

    const list = await api().get('/api/v1/family-profiles').set(auth(user.token));
    expect(list.body.items).toHaveLength(1);

    const updated = await api()
      .patch(`/api/v1/family-profiles/${created.body.id}`)
      .set(auth(user.token))
      .send({ conditions: 'Hypertension', caregiverReminders: false });
    expect(updated.body).toMatchObject({ conditions: 'Hypertension', caregiverReminders: false });

    expect((await api().delete(`/api/v1/family-profiles/${created.body.id}`).set(auth(user.token))).status).toBe(204);
    expect((await api().get('/api/v1/family-profiles').set(auth(user.token))).body.items).toHaveLength(0);
  });

  it('rejects future dates of birth and keeps profiles private to their owner', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    expect((await addProfile(owner.token, { dateOfBirth: '2999-01-01' })).status).toBe(400);

    const { body: mum } = await addProfile(owner.token);
    expect((await api().get(`/api/v1/family-profiles/${mum.id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await api().delete(`/api/v1/family-profiles/${mum.id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await api().get('/api/v1/family-profiles').set(auth(stranger.token))).body.items).toHaveLength(0);
  });

  it('caps the number of family members', async () => {
    const user = await createUser();
    for (let i = 0; i < 12; i++) expect((await addProfile(user.token, { name: `Kid ${i}`, relationship: 'child' })).status).toBe(201);
    const over = await addProfile(user.token);
    expect(over.status).toBe(409);
    expect(over.body.error?.code ?? over.body.code).toBe('FAMILY_LIMIT_REACHED');
  });
});

describe('care plans and medications per person', () => {
  beforeEach(() => resetDatabase());

  const medication = (profileId: string | null = null) => ({
    profileId,
    name: 'Amlodipine',
    startTime: '2026-10-01T00:00:00Z',
    endTime: '2026-12-01T00:00:00Z',
    morningTime: '08:00',
  });

  it('keeps each person’s plans and medications separate', async () => {
    const user = await createUser();
    const { body: mum } = await addProfile(user.token);

    await api().post('/api/v1/care-plans').set(auth(user.token)).send({ kind: 'diabetes', name: 'My sugar' });
    const mumPlan = await api()
      .post('/api/v1/care-plans')
      .set(auth(user.token))
      .send({ profileId: mum.id, kind: 'hypertension', name: 'Mum’s BP' });
    expect(mumPlan.status).toBe(201);
    expect(mumPlan.body.profileId).toBe(mum.id);

    const mine = await api().get('/api/v1/care-plans').set(auth(user.token));
    const hers = await api().get(`/api/v1/care-plans?profileId=${mum.id}`).set(auth(user.token));
    expect(mine.body.items.map((p: { name: string }) => p.name)).toEqual(['My sugar']);
    expect(hers.body.items.map((p: { name: string }) => p.name)).toEqual(['Mum’s BP']);

    await api().post('/api/v1/medications').set(auth(user.token)).send(medication());
    await api().post('/api/v1/medications').set(auth(user.token)).send(medication(mum.id));
    expect((await api().get('/api/v1/medications?profileId=me').set(auth(user.token))).body.items).toHaveLength(1);
    const mumMeds = await api().get(`/api/v1/medications?profileId=${mum.id}`).set(auth(user.token));
    expect(mumMeds.body.items).toHaveLength(1);
    expect(mumMeds.body.items[0].profileId).toBe(mum.id);
  });

  it('refuses to attach records to someone else’s family member', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { body: mum } = await addProfile(owner.token);

    const plan = await api()
      .post('/api/v1/care-plans')
      .set(auth(stranger.token))
      .send({ profileId: mum.id, kind: 'general', name: 'Sneaky' });
    expect(plan.status).toBe(404);
    expect((await api().post('/api/v1/medications').set(auth(stranger.token)).send(medication(mum.id))).status).toBe(404);
    expect((await api().get(`/api/v1/care-plans?profileId=${mum.id}`).set(auth(stranger.token))).status).toBe(404);
  });

  it('removes a family member’s records when they are deleted', async () => {
    const user = await createUser();
    const { body: mum } = await addProfile(user.token);
    await api().post('/api/v1/care-plans').set(auth(user.token)).send({ profileId: mum.id, kind: 'general', name: 'Mum' });
    await api().delete(`/api/v1/family-profiles/${mum.id}`).set(auth(user.token));
    expect(await db.select().from(carePlans).where(eq(carePlans.userId, user.id))).toHaveLength(0);
  });
});

describe('shareable care summary', () => {
  beforeEach(() => resetDatabase());

  async function mumWithReadings() {
    const user = await createUser({ firstName: 'Ada', lastName: 'Obi' });
    const { body: mum } = await addProfile(user.token, { allergies: '<script>alert(1)</script> Penicillin' });
    const { body: plan } = await api()
      .post('/api/v1/care-plans')
      .set(auth(user.token))
      .send({ profileId: mum.id, kind: 'hypertension', name: 'Blood pressure' });
    for (const [s, d] of [[150, 95], [140, 90]]) {
      await api()
        .post(`/api/v1/care-plans/${plan.id}/readings`)
        .set(auth(user.token))
        .send({ systolic: s, diastolic: d, note: '[ctx:resting] after walk' });
    }
    return { user, mum };
  }

  it('previews the summary with averages and parsed reading context', async () => {
    const { user, mum } = await mumWithReadings();
    const res = await api().get(`/api/v1/care-summary?profileId=${mum.id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.person).toMatchObject({ name: 'Mum', relationship: 'parent' });
    expect(res.body.carePlans[0].last30Days).toMatchObject({ count: 2, averageSystolic: 145, averageDiastolic: 93 });
    expect(res.body.carePlans[0].recentReadings[0]).toMatchObject({ context: 'Resting', note: 'after walk' });
  });

  it('shares a read-only, escaped page and stops working once revoked', async () => {
    const { user, mum } = await mumWithReadings();
    const share = await api()
      .post('/api/v1/care-summary/shares')
      .set(auth(user.token))
      .send({ profileId: mum.id, expiresInHours: 24 });
    expect(share.status).toBe(201);
    const token = tokenOf(share.body.url);

    // The token itself is never stored.
    const [row] = await db.select().from(careSummaryShares).where(eq(careSummaryShares.id, share.body.id));
    expect(row!.tokenHash).not.toContain(token);

    const page = await api().get(`/api/v1/care-summaries/${token}`).set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).toContain('Mum');
    expect(page.text).toContain('Shared by Ada Obi');
    expect(page.text).not.toContain('<script>alert(1)</script>');
    expect(page.text).toContain('&lt;script&gt;');

    const json = await api().get(`/api/v1/care-summaries/${token}`).set('Accept', 'application/json');
    expect(json.body.summary.person.name).toBe('Mum');

    const active = await api().get(`/api/v1/care-summary/shares?profileId=${mum.id}`).set(auth(user.token));
    expect(active.body.items[0]).toMatchObject({ id: share.body.id, viewCount: 2 });

    expect((await api().delete(`/api/v1/care-summary/shares/${share.body.id}`).set(auth(user.token))).status).toBe(204);
    expect((await api().get(`/api/v1/care-summaries/${token}`)).status).toBe(404);
  });

  it('treats expired and unknown links as not found', async () => {
    const { user } = await mumWithReadings();
    const share = await api().post('/api/v1/care-summary/shares').set(auth(user.token)).send({ expiresInHours: 1 });
    await db
      .update(careSummaryShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(careSummaryShares.id, share.body.id));
    expect((await api().get(`/api/v1/care-summaries/${tokenOf(share.body.url)}`)).status).toBe(404);
    expect((await api().get(`/api/v1/care-summaries/${'x'.repeat(43)}`)).status).toBe(404);
  });

  it('does not let another user revoke or list my links', async () => {
    const { user } = await mumWithReadings();
    const stranger = await createUser();
    const share = await api().post('/api/v1/care-summary/shares').set(auth(user.token)).send({});
    expect((await api().delete(`/api/v1/care-summary/shares/${share.body.id}`).set(auth(stranger.token))).status).toBe(404);
    expect((await api().get('/api/v1/care-summary/shares').set(auth(stranger.token))).body.items).toHaveLength(0);
  });
});
