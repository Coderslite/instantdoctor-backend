import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, pharmacies } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const application = (overrides: Record<string, unknown> = {}) => ({
  pharmacyName: 'HealthPlus Pharmacy Lekki',
  contactName: 'Tunde Bakare',
  contactRole: 'Superintendent pharmacist',
  email: 'Tunde@HealthPlus.test',
  phone: '0803 123 4567',
  address: '12 Admiralty Way, Lekki Phase 1',
  city: 'Lagos',
  state: 'Lagos',
  licenceNumber: 'PCN/PR/2026/1234',
  branches: '2 – 5',
  latitude: 6.4474,
  longitude: 3.4728,
  message: 'We can deliver across Lekki and VI.',
  ...overrides,
});

const approval = (overrides: Record<string, unknown> = {}) => ({
  name: 'HealthPlus Pharmacy Lekki',
  email: 'tunde@healthplus.test',
  phoneNumber: '0803 123 4567',
  address: '12 Admiralty Way, Lekki Phase 1, Lagos',
  ...overrides,
});

async function adminToken(role: 'admin' | 'marketer' = 'admin') {
  const id = newId();
  await db.insert(admins).values({ id, name: 'Reviewer', email: `${id}@admin.test`, role });
  return signAdminAccessToken({ sub: id, role });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('pharmacy partnership applications', () => {
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
  const submit = (body = application()) => api().post('/api/v1/pharmacy-applications').send(body);
  const portal = (accessToken: string) => ({
    get: (p: string) => api().get(`/api/v1/pharmacy-portal${p}`).set(auth(accessToken)),
    patch: (p: string, b: object) => api().patch(`/api/v1/pharmacy-portal${p}`).set(auth(accessToken)).send(b),
  });

  it('applies, is approved into an onboarding pharmacy, and the emailed password must be changed before setup', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', email: 'tunde@healthplus.test', reference: expect.stringMatching(/^PA-[0-9A-F]{8}$/) });
    await settle();
    expect(outbox.map((m) => m.category).sort()).toEqual(['ops-pharmacy-application', 'pharmacy-application-received']);
    expect(outbox.find((m) => m.category === 'pharmacy-application-received')!.text).toContain(res.body.reference);

    // One open application per email.
    expect((await submit()).body.error.code).toBe('APPLICATION_EXISTS');

    const queue = await admin.get('/pharmacy-applications?status=pending');
    expect(queue.body).toMatchObject({ total: 1, pendingCount: 1 });
    expect(queue.body.items[0]).toMatchObject({ pharmacyName: 'HealthPlus Pharmacy Lekki', licenceNumber: 'PCN/PR/2026/1234', latitude: 6.4474, longitude: 3.4728 });

    outbox = [];
    const approved = await admin.post(`/pharmacy-applications/${res.body.id}/approve`, approval());
    expect(approved.status).toBe(200);
    expect(approved.body.application).toMatchObject({ status: 'approved', pharmacyId: approved.body.pharmacyId, createdPharmacyName: 'HealthPlus Pharmacy Lekki' });
    const password = approved.body.owner.temporaryPassword as string;
    expect(password).toHaveLength(12);
    const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, approved.body.pharmacyId));
    expect(pharmacy).toMatchObject({ status: 'onboarding', email: 'tunde@healthplus.test', mustChangePassword: true });
    await settle();
    const welcome = outbox.find((m) => m.category === 'pharmacy-application-approved')!;
    expect(welcome.to).toBe('tunde@healthplus.test');
    expect(welcome.text).toContain(password);

    // Reviewed once only.
    expect((await admin.post(`/pharmacy-applications/${res.body.id}/reject`, { reason: 'x' })).status).toBe(409);

    // Sign in with the temporary password: only the profile and the password change are open.
    const login = await api().post('/api/v1/pharmacy-portal/auth/login').send({ email: 'tunde@healthplus.test', password });
    expect(login.status).toBe(200);
    expect(login.body.pharmacy).toMatchObject({ accountRole: 'owner', mustChangePassword: true, status: 'onboarding' });
    const first = portal(login.body.session.accessToken);
    expect((await first.get('/me')).body.mustChangePassword).toBe(true);
    expect((await first.get('/dashboard')).status).toBe(403);

    const changed = await first.patch('/password', { currentPassword: password, newPassword: 'My-own-pass-456' });
    expect(changed.status).toBe(200);
    const owner = portal(changed.body.session.accessToken);
    expect((await owner.get('/me')).body.mustChangePassword).toBe(false);
    expect((await owner.get('/dashboard')).status).toBe(200);
    // The temporary password no longer works.
    expect((await api().post('/api/v1/pharmacy-portal/auth/login').send({ email: 'tunde@healthplus.test', password })).status).toBe(401);

    // An approved partner can't apply again with the same email.
    expect((await submit()).body.error.code).toBe('ALREADY_PARTNER');
  });

  it('declines with a reason that is emailed to the applicant', async () => {
    const res = await submit();
    outbox = [];
    expect((await admin.post(`/pharmacy-applications/${res.body.id}/reject`, { reason: '' })).status).toBe(400);
    const declined = await admin.post(`/pharmacy-applications/${res.body.id}/reject`, { reason: 'We could not verify the premises licence.' });
    expect(declined.body).toMatchObject({ status: 'rejected', reviewNote: 'We could not verify the premises licence.' });
    await settle();
    const mail = outbox.find((m) => m.category === 'pharmacy-application-rejected')!;
    expect(mail.text).toContain('We could not verify the premises licence.');
    // A declined applicant may apply again.
    expect((await submit()).status).toBe(201);
  });

  it('validates the form, refuses a sign-in email already in use, and needs an admin to review', async () => {
    const bad = await submit(application({ email: 'nope', phone: '', address: '' }));
    expect(bad.status).toBe(400);
    const res = await submit();
    await db.insert(pharmacies).values({ id: newId(), name: 'Other', email: 'taken@pharmacy.test' });
    const taken = await admin.post(`/pharmacy-applications/${res.body.id}/approve`, approval({ email: 'taken@pharmacy.test' }));
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
    expect((await admin.get(`/pharmacy-applications/${res.body.id}`)).body.status).toBe('pending');

    const marketer = await adminToken('marketer');
    const blocked = await api().post(`/api/v1/admin/pharmacy-applications/${res.body.id}/approve`).set(auth(marketer)).send(approval());
    expect(blocked.status).toBe(403);
    expect((await api().get('/api/v1/admin/pharmacy-applications')).status).toBe(401);
  });
});
