import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createDoctor, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const letter = {
  subject: 'Changes to consultation hours',
  body: '<p>Hello {{firstName}}, our hours are changing.</p><script>alert(1)</script><p class="x">Thank you.</p>',
  signatureName: 'Dr. Nzei Kanayo',
  signatureTitle: 'Chief Operating Officer',
};

async function createAdmin(role: 'admin' | 'marketer' = 'admin') {
  const id = newId();
  await db.insert(admins).values({ id, name: 'Ops Lead', email: `${id}@admin.test`, role });
  return { id, email: `${id}@admin.test`, token: signAdminAccessToken({ sub: id, role }) };
}

/** Background sends finish asynchronously; poll the history until this one is done. */
async function settled(token: string, id: string) {
  for (let i = 0; i < 50; i++) {
    const res = await api().get(`/api/v1/admin/mail/${id}`).set(auth(token));
    if (res.body.status !== 'sending') return res.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('send did not finish');
}

describe('admin mail centre', () => {
  let outbox: OutgoingMail[];
  const delay = env.MAIL_BULK_DELAY_MS;

  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    env.MAIL_BULK_DELAY_MS = 0;
    setMailSink(async (mail) => {
      if (mail.to.startsWith('bounce')) throw new Error('550 mailbox unavailable');
      outbox.push(mail);
    });
  });
  afterEach(() => {
    setMailSink(undefined);
    env.MAIL_BULK_DELAY_MS = delay;
  });

  it('renders an official letter preview with letterhead, reference, signature and footer', async () => {
    const { token } = await createAdmin();
    const res = await api()
      .post('/api/v1/admin/mail/preview')
      .set(auth(token))
      .send({ ...letter, recipientName: 'Chioma Eze' });
    expect(res.status).toBe(200);
    const html: string = res.body.html;
    expect(html).toContain(env.MAIL_LOGO_URL);
    expect(html).toContain('Dear Chioma Eze,');
    expect(html).toContain('CHANGES TO CONSULTATION HOURS');
    expect(html).toContain('Hello Chioma, our hours are changing.');
    expect(html).toContain('Dr. Nzei Kanayo');
    expect(html).toContain('All rights reserved.');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('class="x"');
  });

  it('sends one personal letter per recipient from contact@ and records each delivery', async () => {
    const { token } = await createAdmin();
    const patient = {
      ...(await createUser({ firstName: 'Bola', lastName: 'Ade', email: 'bola@patient.test' })),
      email: 'bola@patient.test',
    };
    const res = await api()
      .post('/api/v1/admin/mail')
      .set(auth(token))
      .send({
        ...letter,
        userIds: [patient.id],
        emails: [
          { email: 'partner@clinic.test', name: 'Lagos Clinic' },
          { email: 'bounce@nowhere.test' },
          { email: patient.email },
        ],
      });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'sending',
      recipientCount: 3,
      reference: expect.stringMatching(/^ID\/\d{4}\/\d{2}\/0001$/),
    });

    const done = await settled(token, res.body.id);
    expect(done).toMatchObject({ status: 'partial', sentCount: 2, failedCount: 1 });
    expect(
      done.recipients.find((r: { email: string }) => r.email === 'bounce@nowhere.test'),
    ).toMatchObject({ status: 'failed', error: expect.stringContaining('550') });

    expect(outbox.map((m) => m.to).sort()).toEqual(['partner@clinic.test', patient.email].sort());
    for (const mail of outbox) {
      expect(mail).toMatchObject({
        from: env.MAIL_OFFICIAL_FROM,
        replyTo: env.MAIL_OFFICIAL_REPLY_TO,
        subject: letter.subject,
      });
    }
    expect(outbox.find((m) => m.to === patient.email)!.html).toContain('Hello Bola,');
    expect(outbox.find((m) => m.to === 'partner@clinic.test')!.html).toContain(
      'Dear Lagos Clinic,',
    );
    expect(outbox[0]!.text).toContain('Yours sincerely,');
  });

  it('mails a whole segment, skipping suspended accounts', async () => {
    const { token } = await createAdmin();
    await createUser();
    await createUser({ accountStatus: 'suspended' });
    await createDoctor();
    expect(
      (await api().get('/api/v1/admin/mail/audience?segment=patients').set(auth(token))).body
        .recipients,
    ).toBe(1);

    const res = await api()
      .post('/api/v1/admin/mail')
      .set(auth(token))
      .send({ ...letter, segment: 'doctors' });
    const done = await settled(token, res.body.id);
    expect(done).toMatchObject({ status: 'sent', recipientCount: 1, sentCount: 1 });

    const listed = await api().get('/api/v1/admin/mail').set(auth(token));
    expect(listed.body).toMatchObject({
      total: 1,
      items: [{ subject: letter.subject, sentBy: 'Ops Lead' }],
    });
  });

  it('sends a test only to the signed-in admin', async () => {
    const admin = await createAdmin();
    const res = await api().post('/api/v1/admin/mail/test').set(auth(admin.token)).send(letter);
    expect(res.body).toEqual({ sentTo: admin.email });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: admin.email, subject: `[TEST] ${letter.subject}` });
  });

  it('writes to organisations outside the platform with a business address block', async () => {
    const { token } = await createAdmin();
    const res = await api()
      .post('/api/v1/admin/mail')
      .set(auth(token))
      .send({
        ...letter,
        emails: [
          {
            email: 'partnerships@hmo.example',
            organization: 'Avon Healthcare HMO',
            address: '12 Admiralty Way\nLekki Phase 1, Lagos',
          },
          {
            email: 'cfo@hmo.example',
            name: 'Mrs. Funmi Bello',
            title: 'Chief Financial Officer',
            organization: 'Avon Healthcare HMO',
          },
        ],
      });
    expect(res.status).toBe(202);
    const done = await settled(token, res.body.id);
    expect(done).toMatchObject({ status: 'sent', sentCount: 2 });
    expect(
      done.recipients.find((r: { email: string }) => r.email === 'cfo@hmo.example').details,
    ).toMatchObject({ organization: 'Avon Healthcare HMO', title: 'Chief Financial Officer' });

    const toTeam = outbox.find((m) => m.to === 'partnerships@hmo.example')!;
    expect(toTeam.html).toContain(
      'Avon Healthcare HMO<br>12 Admiralty Way<br>Lekki Phase 1, Lagos',
    );
    expect(toTeam.html).toContain('Dear Sir/Madam,');
    const toCfo = outbox.find((m) => m.to === 'cfo@hmo.example')!;
    expect(toCfo.html).toContain(
      'Mrs. Funmi Bello<br>Chief Financial Officer<br>Avon Healthcare HMO',
    );
    expect(toCfo.html).toContain('Dear Mrs. Funmi Bello,');
    expect(toCfo.text).toContain('Chief Financial Officer\nAvon Healthcare HMO');
  });

  it('includes the app store links and contact details in a patient email', async () => {
    const { token } = await createAdmin();
    const patient = await createUser({ firstName: 'Bola', email: 'bola2@patient.test' });
    const res = await api()
      .post(`/api/v1/admin/patients/${patient.id}/email`)
      .set(auth(token))
      .send({ subject: 'Your results', message: 'Please check the app.' });
    expect(res.status).toBe(200);
    const mail = outbox.find((m) => m.to === 'bola2@patient.test')!;
    expect(mail.html).toContain('play.google.com/store/apps/details?id=com.instantdoctor.app');
    expect(mail.html).toContain('apps.apple.com/us/app/instant-doctor-telehealth');
    expect(mail.html).toContain(env.MAIL_OFFICIAL_REPLY_TO);
    expect(mail.text).toContain('Google Play: https://play.google.com');
  });

  it('requires recipients and a sending role', async () => {
    const { token } = await createAdmin();
    expect((await api().post('/api/v1/admin/mail').set(auth(token)).send(letter)).status).toBe(400);
    const marketer = await createAdmin('marketer');
    expect(
      (
        await api()
          .post('/api/v1/admin/mail')
          .set(auth(marketer.token))
          .send({ ...letter, emails: [{ email: 'a@b.test' }] })
      ).status,
    ).toBe(202);
    expect((await api().get('/api/v1/admin/mail')).status).toBe(401);
  });
});
