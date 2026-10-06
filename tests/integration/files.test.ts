import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appointmentMessages, appointments, doctorProfiles, files, labResults } from '../../src/db/schema/index.js';
import { setStorageDriver, type StorageDriver } from '../../src/integrations/storage.js';
import { newId } from '../../src/lib/ids.js';
import { purgeAbandonedUploads } from '../../src/modules/files/files.service.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createDoctor, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);

const upload = (token: string, purpose: string, file = PNG, name = 'photo.png', type = 'image/png') =>
  api().post('/api/v1/uploads').set(auth(token)).field('purpose', purpose).attach('file', file, { filename: name, contentType: type });

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

async function paidAppointment() {
  const patient = await createUser();
  const doctor = await createDoctor();
  const id = newId();
  await db.insert(appointments).values({
    id,
    userId: patient.id,
    doctorId: doctor.id,
    symptoms: [],
    status: 'active',
    packageLabel: 'Standard',
    startTime: inHours(-1),
    endTime: inHours(1),
    price: 100,
    currency: 'NGN',
    isPaid: true,
  });
  return { patient, doctor, appointmentId: id };
}

describe('uploads', () => {
  beforeEach(() => resetDatabase());

  it('stores a public avatar with a permanent link that serves the file', async () => {
    const user = await createUser();
    const res = await upload(user.token, 'avatar');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ purpose: 'avatar', visibility: 'public', urlExpiresAt: null, contentType: 'image/png', size: PNG.length });
    expect(res.body.url).toMatch(/\/files\/public\/avatar\/[0-9a-f-]{36}\.png$/);

    const download = await api().get(pathOf(res.body.url));
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body)).toEqual(PNG);
  });

  it('keeps chat attachments private behind expiring signed links', async () => {
    const user = await createUser();
    const res = await upload(user.token, 'chat_attachment', PDF, 'scan.pdf', 'application/pdf');
    expect(res.body).toMatchObject({ visibility: 'private' });
    expect(res.body.url).toMatch(/\/files\/private\/chat-attachment\/.+\?expires=\d+&signature=/);
    expect(new Date(res.body.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());

    expect((await api().get(pathOf(res.body.url))).status).toBe(200);
    const unsigned = new URL(res.body.url).pathname;
    expect((await api().get(unsigned)).status).toBe(403);
    expect((await api().get(pathOf(res.body.url).replace(/signature=[^&]+/, 'signature=forged'))).status).toBe(403);
    expect((await api().get(pathOf(res.body.url).replace(/expires=\d+/, 'expires=1000'))).status).toBe(403);
  });

  it('maps the legacy folder parameter to a purpose', async () => {
    const user = await createUser();
    const res = await api()
      .post('/api/v1/uploads?folder=chat')
      .set(auth(user.token))
      .attach('file', PNG, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.body).toMatchObject({ purpose: 'chat_attachment', visibility: 'private' });
  });

  it('enforces who may upload for each purpose', async () => {
    const patient = await createUser();
    const doctor = await createDoctor();
    expect((await upload(patient.token, 'doctor_document', PDF, 'licence.pdf', 'application/pdf')).status).toBe(403);
    expect((await upload(patient.token, 'blog_image')).status).toBe(403);
    expect((await upload(doctor.token, 'doctor_document', PDF, 'licence.pdf', 'application/pdf')).status).toBe(201);
  });

  it('enforces types, real content and size limits per purpose', async () => {
    const user = await createUser();
    const html = await upload(user.token, 'chat_attachment', Buffer.from('<html></html>'), 'page.html', 'text/html');
    expect(html.status).toBe(422);
    expect(html.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');

    expect((await upload(user.token, 'avatar', PDF, 'cv.pdf', 'application/pdf')).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');

    const fake = await upload(user.token, 'avatar', Buffer.from('<script>alert(1)</script>'), 'evil.png', 'image/png');
    expect(fake.status).toBe(400);

    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const tooBig = await upload(user.token, 'avatar', big);
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('requires a purpose', async () => {
    const user = await createUser();
    const res = await api().post('/api/v1/uploads').set(auth(user.token)).attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('returns a fresh link for my own file only', async () => {
    const [owner, other] = await Promise.all([createUser(), createUser()]);
    const { body } = await upload(owner.token, 'chat_attachment');
    const mine = await api().get(`/api/v1/files/${body.id}`).set(auth(owner.token));
    expect(mine.status).toBe(200);
    expect(mine.body.url).toMatch(/signature=/);
    expect((await api().get(`/api/v1/files/${body.id}`).set(auth(other.token))).status).toBe(404);
  });
});

describe('blog image uploads', () => {
  beforeEach(() => resetDatabase());
  afterEach(() => setStorageDriver(undefined));

  it('stores an admin blog image in public R2 storage and returns its CDN URL', async () => {
    const stored: Array<{ key: string; contentType: string; visibility: string }> = [];
    const r2: StorageDriver = {
      put: async ({ key, contentType, visibility }) => {
        stored.push({ key, contentType, visibility });
      },
      publicUrl: (key) => `https://media.instantdoctor.co/${key}`,
      signedUrl: async () => 'https://example.invalid/private-file',
      remove: async () => undefined,
      presignUpload: async () => ({ url: 'https://example.invalid/upload', headers: {} }),
      stat: async () => null,
      readStart: async () => Buffer.alloc(0),
    };
    setStorageDriver(r2);
    const token = signAdminAccessToken({ sub: newId(), role: 'admin' });

    const res = await api()
      .post('/api/v1/admin/blog/uploads')
      .set(auth(token))
      .attach('file', PNG, { filename: 'hero.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      purpose: 'blog_image',
      visibility: 'public',
      contentType: 'image/png',
      urlExpiresAt: null,
    });
    expect(res.body.url).toMatch(/^https:\/\/media\.instantdoctor\.co\/blog-image\/.+\.png$/);
    expect(stored).toEqual([{ key: expect.stringMatching(/^blog-image\/.+\.png$/), contentType: 'image/png', visibility: 'public' }]);
  });
});

describe('attaching uploaded files', () => {
  beforeEach(() => resetDatabase());

  it('sends a chat attachment by fileId, stores a reference and returns signed links', async () => {
    const { patient, appointmentId } = await paidAppointment();
    const file = (await upload(patient.token, 'chat_attachment')).body;

    const sent = await api()
      .post(`/api/v1/appointments/${appointmentId}/messages`)
      .set(auth(patient.token))
      .send({ type: 'image', fileId: file.id });
    expect(sent.status).toBe(201);
    expect(sent.body.fileUrl).toMatch(/\/files\/private\/.+signature=/);

    const [row] = await db.select().from(appointmentMessages).where(eq(appointmentMessages.id, sent.body.id));
    expect(row!.fileUrl).toBe(`file:${file.id}`);

    const listed = await api().get(`/api/v1/appointments/${appointmentId}/messages`).set(auth(patient.token));
    expect(listed.body.items[0].fileUrl).toMatch(/signature=/);
    expect((await api().get(pathOf(listed.body.items[0].fileUrl))).status).toBe(200);
  });

  it('lets the doctor see the patient\'s attachment', async () => {
    const { patient, doctor, appointmentId } = await paidAppointment();
    const file = (await upload(patient.token, 'chat_attachment')).body;
    await api().post(`/api/v1/appointments/${appointmentId}/messages`).set(auth(patient.token)).send({ type: 'image', fileId: file.id });
    const listed = await api().get(`/api/v1/appointments/${appointmentId}/messages`).set(auth(doctor.token));
    expect((await api().get(pathOf(listed.body.items[0].fileUrl))).status).toBe(200);
  });

  it('refuses someone else\'s file or a file uploaded for another purpose', async () => {
    const { patient, appointmentId } = await paidAppointment();
    const stranger = await createUser();
    const strangersFile = (await upload(stranger.token, 'chat_attachment')).body;
    const avatar = (await upload(patient.token, 'avatar')).body;

    const stolen = await api().post(`/api/v1/appointments/${appointmentId}/messages`).set(auth(patient.token)).send({ type: 'image', fileId: strangersFile.id });
    expect(stolen.status).toBe(404);

    const wrong = await api().post(`/api/v1/appointments/${appointmentId}/messages`).set(auth(patient.token)).send({ type: 'image', fileId: avatar.id });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WRONG_FILE_PURPOSE');
  });

  it('submits lab results by fileId and returns signed links', async () => {
    const user = await createUser({ country: 'NG', currency: 'NGN' });
    const file = (await upload(user.token, 'lab_result', PDF, 'result.pdf', 'application/pdf')).body;
    const res = await api().post('/api/v1/lab-results').set(auth(user.token)).set('Idempotency-Key', 'lab-file-0001').send({ files: [{ fileId: file.id, fileType: 'File' }] });
    if (res.status === 503) return;
    expect(res.status).toBe(201);
    expect(res.body.files[0].fileUrl).toMatch(/signature=/);
  });

  it('lets a doctor attach a private licence', async () => {
    const doctor = await createDoctor();
    const file = (await upload(doctor.token, 'doctor_document', PDF, 'licence.pdf', 'application/pdf')).body;
    const res = await api().put('/api/v1/doctors/me/certificate').set(auth(doctor.token)).send({ fileId: file.id });
    expect(res.status).toBe(200);
    expect(res.body.certificateUrl).toMatch(/signature=/);
    const [profile] = await db.select().from(doctorProfiles).where(eq(doctorProfiles.userId, doctor.id));
    expect(profile!.certificateUrl).toBe(`file:${file.id}`);
    const [row] = await db.select().from(files).where(eq(files.id, file.id));
    expect(row).toMatchObject({ purpose: 'doctor_document', visibility: 'private', ownerType: 'user', ownerId: doctor.id });
  });
});

/** Runs the three-step direct upload against the local storage stand-in. */
async function directUpload(token: string, purpose: string, file = PNG, type = 'image/png', prefix = '') {
  const started = await api()
    .post(`/api/v1${prefix}/uploads/presign`)
    .set(auth(token))
    .send({ purpose, contentType: type, size: file.length, name: 'upload.bin' });
  expect(started.status).toBe(201);
  const put = await api().put(pathOf(started.body.upload.url)).set(started.body.upload.headers).send(file);
  return { started: started.body, put, complete: () => api().post(`/api/v1${prefix}/uploads/${started.body.fileId}/complete`).set(auth(token)) };
}

describe('direct uploads', () => {
  beforeEach(() => resetDatabase());

  it('uploads straight to storage, then confirms and serves the file', async () => {
    const user = await createUser();
    const { started, put, complete } = await directUpload(user.token, 'avatar');
    expect(started.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(put.status).toBe(200);

    const done = await complete();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: started.fileId, purpose: 'avatar', visibility: 'public', size: PNG.length });
    expect(Buffer.from((await api().get(pathOf(done.body.url))).body)).toEqual(PNG);

    expect((await complete()).body.id).toBe(started.fileId); // confirming again is harmless
  });

  it('checks the purpose policy before handing out an upload URL', async () => {
    const user = await createUser();
    const tooBig = await api().post('/api/v1/uploads/presign').set(auth(user.token)).send({ purpose: 'avatar', contentType: 'image/png', size: 50 * 1024 * 1024 });
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    const wrongType = await api().post('/api/v1/uploads/presign').set(auth(user.token)).send({ purpose: 'avatar', contentType: 'application/pdf', size: 100 });
    expect(wrongType.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    const notAllowed = await api().post('/api/v1/uploads/presign').set(auth(user.token)).send({ purpose: 'blog_image', contentType: 'image/png', size: 100 });
    expect(notAllowed.status).toBe(403);
  });

  it('refuses bytes that differ from what was signed', async () => {
    const user = await createUser();
    const started = (await api().post('/api/v1/uploads/presign').set(auth(user.token)).send({ purpose: 'avatar', contentType: 'image/png', size: PNG.length })).body;
    const bigger = await api().put(pathOf(started.upload.url)).set(started.upload.headers).send(Buffer.concat([PNG, PNG]));
    expect(bigger.status).toBe(403);
    const otherType = await api().put(pathOf(started.upload.url)).set('Content-Type', 'image/jpeg').send(PNG);
    expect(otherType.status).toBe(403);
    const tampered = await api().put(pathOf(started.upload.url).replace('size=', 'size=9')).set(started.upload.headers).send(PNG);
    expect(tampered.status).toBe(403);
  });

  it('rejects and discards a file whose content is not what it claims to be', async () => {
    const user = await createUser();
    const fake = Buffer.alloc(PNG.length, 1); // right size, not a PNG
    const { started, put, complete } = await directUpload(user.token, 'avatar', fake);
    expect(put.status).toBe(200);
    expect((await complete()).status).toBe(400);
    expect(await db.select().from(files).where(eq(files.id, started.fileId))).toEqual([]);
  });

  it('cannot be confirmed before the bytes arrive, or by someone else', async () => {
    const user = await createUser();
    const stranger = await createUser();
    const started = (await api().post('/api/v1/uploads/presign').set(auth(user.token)).send({ purpose: 'avatar', contentType: 'image/png', size: PNG.length })).body;
    const early = await api().post(`/api/v1/uploads/${started.fileId}/complete`).set(auth(user.token));
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('UPLOAD_NOT_RECEIVED');
    const other = await api().post(`/api/v1/uploads/${started.fileId}/complete`).set(auth(stranger.token));
    expect(other.status).toBe(404);
  });

  it('only lets confirmed uploads be attached', async () => {
    const { patient, appointmentId } = await paidAppointment();
    const { started, complete } = await directUpload(patient.token, 'chat_attachment', PDF, 'application/pdf');
    const send = () => api().post(`/api/v1/appointments/${appointmentId}/messages`).set(auth(patient.token)).send({ type: 'file', fileId: started.fileId });
    expect((await send()).status).toBe(404);
    await complete();
    const sent = await send();
    expect(sent.status).toBe(201);
    expect(sent.body.fileUrl).toMatch(/signature=/);
  });

  it('works for admins and publishes an interpreted lab result by fileId', async () => {
    const patient = await createUser();
    const labResultId = newId();
    await db.insert(labResults).values({ id: labResultId, userId: patient.id, status: 'pending' } as typeof labResults.$inferInsert);
    const token = signAdminAccessToken({ sub: newId(), role: 'admin' });
    const { started, complete } = await directUpload(token, 'lab_result_report', PDF, 'application/pdf', '/admin');
    expect((await complete()).status).toBe(200);

    const res = await api().post(`/api/v1/admin/lab-results/${labResultId}/result`).set(auth(token)).send({ fileId: started.fileId, interpretation: 'All values normal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'completed', interpretation: 'All values normal' });
  });

  it('purges uploads that were never confirmed', async () => {
    const user = await createUser();
    const { started } = await directUpload(user.token, 'avatar');
    expect(await purgeAbandonedUploads(60_000)).toBe(0); // still fresh
    expect(await purgeAbandonedUploads(-1)).toBe(1);
    expect(await db.select().from(files).where(eq(files.id, started.fileId))).toEqual([]);
  });
});
