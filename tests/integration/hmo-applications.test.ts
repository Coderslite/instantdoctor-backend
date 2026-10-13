import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const application = (overrides: Record<string, unknown> = {}) => ({
  organisation: 'Crest Health HMO',
  contactName: 'Ada Obi',
  contactRole: 'Head of Partnerships',
  email: 'Ada@Crest.test',
  phone: '0803 123 4567',
  enrollees: '1,000 – 10,000',
  services: ['Doctor consultations', 'Prescribed medicines'],
  message: 'We would like to cover GP visits for our Gold plan.',
  ...overrides,
});

const approval = (overrides: Record<string, unknown> = {}) => ({
  name: 'Crest Health HMO',
  code: 'crest',
  contactName: 'Ada Obi',
  contactEmail: 'ada@crest.test',
  adminName: 'Ada Obi',
  adminEmail: 'ada@crest.test',
  ...overrides,
});

async function adminToken(role: 'admin' | 'marketer' = 'admin') {
  const id = newId();
  await db.insert(admins).values({ id, name: 'Reviewer', email: `${id}@admin.test`, role });
  return signAdminAccessToken({ sub: id, role });
}

describe('HMO partnership applications', () => {
  let outbox: OutgoingMail[];
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    setMailSink(async (mail) => {
      outbox.push(mail);
    });
    token = await adminToken();
  });
  afterEach(() => setMailSink(undefined));

  const admin = {
    get: (p: string) => api().get(`/api/v1/admin${p}`).set(auth(token)),
    post: (p: string, b: object = {}) => api().post(`/api/v1/admin${p}`).set(auth(token)).send(b),
  };
  const categories = () => outbox.map((m) => m.category);
  const submit = (body = application()) => api().post('/api/v1/hmo-applications').send(body);

  it('submits, approves into a paused HMO, and the emailed password signs in to the portal', async () => {
    const submitted = await submit();
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'pending', email: 'ada@crest.test' });
    expect(submitted.body.reference).toMatch(/^HA-[0-9A-F]{8}$/);
    expect(categories()).toEqual(expect.arrayContaining(['hmo-application-received', 'ops-hmo-application']));

    const listed = await admin.get('/hmo-applications?status=pending');
    expect(listed.body).toMatchObject({ total: 1, pendingCount: 1 });
    expect(listed.body.items[0]).toMatchObject({ organisation: 'Crest Health HMO', services: ['Doctor consultations', 'Prescribed medicines'] });

    const approved = await admin.post(`/hmo-applications/${submitted.body.id}/approve`, approval());
    expect(approved.status).toBe(200);
    expect(approved.body.application).toMatchObject({ status: 'approved', hmoName: 'Crest Health HMO', reviewerName: 'Reviewer' });
    const password = approved.body.portalAdmin.temporaryPassword as string;
    expect(password).toHaveLength(12);

    const hmo = await admin.get(`/hmos/${approved.body.hmoId}`);
    expect(hmo.body).toMatchObject({ code: 'CREST', status: 'paused' });

    const mail = outbox.find((m) => m.category === 'hmo-application-approved');
    expect(mail?.to).toBe('ada@crest.test');
    expect(mail?.text).toContain(password);
    expect(mail?.text).toContain('https://hmo.instantdoctor.co');

    const login = await api().post('/api/v1/hmo-portal/auth/login').send({ email: 'ada@crest.test', password });
    expect(login.status).toBe(200);
    expect(login.body.account).toMatchObject({ role: 'admin', mustChangePassword: true });

    const again = await admin.post(`/hmo-applications/${submitted.body.id}/approve`, approval({ code: 'CREST2' }));
    expect(again.status).toBe(409);
    expect(again.body.code ?? again.body.error?.code).toBe('APPLICATION_REVIEWED');
  });

  it('allows one pending application per email', async () => {
    expect((await submit()).status).toBe(201);
    const duplicate = await submit(application({ email: 'ada@crest.test' }));
    expect(duplicate.status).toBe(409);
  });

  it('keeps the application pending when the code or portal email is taken', async () => {
    const existing = await admin.post('/hmos', { name: 'Existing', code: 'CREST' });
    expect(existing.status).toBe(201);
    const { body } = await submit();
    const clash = await admin.post(`/hmo-applications/${body.id}/approve`, approval());
    expect(clash.status).toBe(409);
    expect((await admin.get(`/hmo-applications/${body.id}`)).body.status).toBe('pending');

    const user = await admin.post(`/hmos/${existing.body.id}/users`, { name: 'Taken', email: 'ada@crest.test', role: 'admin', password: 'Temp-pass-123' });
    expect(user.status).toBe(201);
    const taken = await admin.post(`/hmo-applications/${body.id}/approve`, approval({ code: 'CRESTH' }));
    expect(taken.status).toBe(409);
    expect((await admin.get(`/hmo-applications/${body.id}`)).body.status).toBe('pending');
  });

  it('rejects with a reason that is emailed, and only admins can review', async () => {
    const { body } = await submit();
    const marketer = await adminToken('marketer');
    const denied = await api().post(`/api/v1/admin/hmo-applications/${body.id}/reject`).set(auth(marketer)).send({ reason: 'No' });
    expect(denied.status).toBe(403);

    const rejected = await admin.post(`/hmo-applications/${body.id}/reject`, { reason: 'We are not onboarding HMOs in this state yet.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', reviewNote: 'We are not onboarding HMOs in this state yet.' });
    expect(outbox.find((m) => m.category === 'hmo-application-rejected')?.text).toContain('not onboarding HMOs');
  });
});
