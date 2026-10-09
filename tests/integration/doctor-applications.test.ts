import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, doctorProfiles, files, REQUIRED_DOCTOR_DOCUMENTS, users } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);

const uploadDocument = () =>
  api()
    .post('/api/v1/doctor-applications/documents')
    .attach('file', PDF, { filename: 'licence.pdf', contentType: 'application/pdf' });

async function application(overrides: Record<string, unknown> = {}) {
  const documents = [];
  for (const type of REQUIRED_DOCTOR_DOCUMENTS) {
    const res = await uploadDocument();
    expect(res.status).toBe(201);
    documents.push({ type, fileId: res.body.id });
  }
  return {
    email: 'Ada.Obi@Example.com',
    password: 'correct-horse-1',
    firstName: 'Ada',
    lastName: 'Obi',
    country: 'NG',
    phoneNumber: '0803 123 4567',
    specialization: 'General practice',
    experienceYears: 6,
    licenceNumber: 'MDCN/12345',
    licensingBody: 'Medical and Dental Council of Nigeria',
    institution: 'University of Lagos',
    graduationYear: '2017',
    documents,
    acceptTerms: true,
    ...overrides,
  };
}

async function adminToken() {
  const id = newId();
  await db.insert(admins).values({ id, name: 'Reviewer', email: `${id}@admin.test`, role: 'admin' });
  return signAdminAccessToken({ sub: id, role: 'admin' });
}

describe('provider applications', () => {
  let outbox: OutgoingMail[];

  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    setMailSink(async (mail) => {
      outbox.push(mail);
    });
  });
  afterEach(() => setMailSink(undefined));

  const categories = () => outbox.map((m) => m.category);

  it('submits, blocks sign-in while pending, then approval creates a doctor who signs in with the same password', async () => {
    const submitted = await api().post('/api/v1/doctor-applications').send(await application());
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'pending', email: 'ada.obi@example.com' });
    expect(submitted.body.reference).toMatch(/^DA-[0-9A-F]{8}$/);
    expect(categories()).toEqual(expect.arrayContaining(['doctor-application-received', 'ops-doctor-application']));

    const pendingLogin = await api().post('/api/v1/auth/login').send({ email: 'ada.obi@example.com', password: 'correct-horse-1' });
    expect(pendingLogin.status).toBe(403);
    expect(pendingLogin.body.error.code).toBe('APPLICATION_PENDING');
    const wrongPassword = await api().post('/api/v1/auth/login').send({ email: 'ada.obi@example.com', password: 'not-the-password' });
    expect(wrongPassword.status).toBe(401);

    const token = await adminToken();
    const listed = await api().get('/api/v1/admin/doctor-applications?status=pending').set(auth(token));
    expect(listed.body).toMatchObject({ total: 1, pendingCount: 1 });

    const detail = await api().get(`/api/v1/admin/doctor-applications/${submitted.body.id}`).set(auth(token));
    expect(detail.body.passwordHash).toBeUndefined();
    expect(detail.body.documents).toHaveLength(REQUIRED_DOCTOR_DOCUMENTS.length);
    expect(detail.body.documents[0].url).toMatch(/signature=/);

    const approved = await api().post(`/api/v1/admin/doctor-applications/${submitted.body.id}/approve`).set(auth(token)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', reviewerName: 'Reviewer' });
    expect(categories()).toContain('doctor-application-approved');

    const [doctor] = await db.select().from(users).where(eq(users.email, 'ada.obi@example.com'));
    expect(doctor).toMatchObject({ role: 'doctor', registrationStatus: 'active', phoneNumber: '+2348031234567' });
    const [profile] = await db.select().from(doctorProfiles).where(eq(doctorProfiles.userId, doctor!.id));
    expect(profile).toMatchObject({ specialization: 'General practice', experienceYears: 6, isAvailable: false });
    expect(profile!.certificateUrl).toMatch(/^file:/);
    const owned = await db.select().from(files).where(eq(files.ownerId, doctor!.id));
    expect(owned).toHaveLength(REQUIRED_DOCTOR_DOCUMENTS.length);

    const login = await api().post('/api/v1/auth/login').send({ email: 'ada.obi@example.com', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('doctor');

    const again = await api().post(`/api/v1/admin/doctor-applications/${submitted.body.id}/approve`).set(auth(token)).send({});
    expect(again.status).toBe(409);
  });

  it('rejects with a reason and lets the applicant apply again', async () => {
    const submitted = await api().post('/api/v1/doctor-applications').send(await application());
    const duplicate = await api().post('/api/v1/doctor-applications').send(await application());
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('APPLICATION_EXISTS');

    const token = await adminToken();
    const rejected = await api()
      .post(`/api/v1/admin/doctor-applications/${submitted.body.id}/reject`)
      .set(auth(token))
      .send({ reason: 'The practising licence has expired.' });
    expect(rejected.body).toMatchObject({ status: 'rejected', reviewNote: 'The practising licence has expired.' });
    expect(outbox.find((m) => m.category === 'doctor-application-rejected')?.text).toContain('The practising licence has expired.');

    const login = await api().post('/api/v1/auth/login').send({ email: 'ada.obi@example.com', password: 'correct-horse-1' });
    expect(login.body.error.code).toBe('APPLICATION_REJECTED');

    expect((await api().post('/api/v1/doctor-applications').send(await application())).status).toBe(201);
  });

  it('requires every mandatory document and refuses documents already used', async () => {
    const complete = await application();
    const missing = await api()
      .post('/api/v1/doctor-applications')
      .send({ ...complete, documents: complete.documents.filter((d) => d.type !== 'government_id') });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ path: 'documents.government_id', message: 'Required' }]);

    expect((await api().post('/api/v1/doctor-applications').send(complete)).status).toBe(201);
    const reused = await api().post('/api/v1/doctor-applications').send({ ...complete, email: 'someone.else@example.com' });
    expect(reused.status).toBe(400);
  });

  it('refuses an email that already has an account', async () => {
    await createUser({ email: 'ada.obi@example.com', registrationStatus: 'active' });
    const res = await api().post('/api/v1/doctor-applications').send(await application());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });
});
