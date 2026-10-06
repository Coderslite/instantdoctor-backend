import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { api, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('emails sent by account flows', () => {
  let outbox: OutgoingMail[];

  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    setMailSink(async (mail) => {
      outbox.push(mail);
    });
  });
  afterEach(() => setMailSink(undefined));

  const byCategory = (category: string) => outbox.filter((m) => m.category === category);

  it('sign-up sends the code, then a welcome email and an ops notice once verified', async () => {
    await api().post('/api/v1/auth/register').send({
      email: 'ada@example.com',
      password: 'Sup3rSecret!',
      firstName: 'Ada',
      lastName: 'Obi',
      phoneNumber: '+2348012345678',
      gender: 'Female',
    });
    const [codeMail] = byCategory('code-register');
    expect(codeMail).toMatchObject({ to: 'ada@example.com' });
    const code = codeMail!.subject.match(/^(\d{5}) is your Instant Doctor verification code$/)![1]!;
    expect(codeMail!.text).toContain('Hi Ada,');
    expect(byCategory('welcome')).toHaveLength(0);

    await api().post('/api/v1/auth/register/verify').send({ email: 'ada@example.com', otp: code });
    await settle();
    expect(byCategory('welcome')).toEqual([expect.objectContaining({ to: 'ada@example.com' })]);
    expect(byCategory('ops-activity')).toEqual([
      expect.objectContaining({ to: 'activities@instantdoctor.co', subject: '[Activity] Registration – Ada Obi' }),
    ]);
  });

  it('login sends a sign-in alert naming the device', async () => {
    await createUser({ email: 'ada@example.com', firstName: 'Ada', passwordHash: await hashPassword('OldPassw0rd!') });
    await api()
      .post('/api/v1/auth/login')
      .set('X-Client-Platform', 'android')
      .send({ email: 'ada@example.com', password: 'OldPassw0rd!' });
    await settle();
    const [alert] = byCategory('sign-in');
    expect(alert).toMatchObject({ to: 'ada@example.com', subject: 'New sign-in to your Instant Doctor account' });
    expect(alert!.text).toContain('Device: Instant Doctor app on Android');
  });

  it('a failed login sends nothing', async () => {
    await createUser({ email: 'ada@example.com', passwordHash: await hashPassword('OldPassw0rd!') });
    await api().post('/api/v1/auth/login').send({ email: 'ada@example.com', password: 'wrong-password' });
    await settle();
    expect(outbox).toHaveLength(0);
  });

  it('a password reset sends the reset code, then a password-changed notice', async () => {
    await createUser({ email: 'ada@example.com', firstName: 'Ada', passwordHash: await hashPassword('OldPassw0rd!') });
    await api().post('/api/v1/auth/password/forgot').send({ email: 'ada@example.com' });
    const [codeMail] = byCategory('code-password_reset');
    expect(codeMail!.subject).toMatch(/^\d{5} is your Instant Doctor password reset code$/);
    const code = codeMail!.subject.slice(0, 5);

    const { resetToken } = (await api().post('/api/v1/auth/password/verify-code').send({ email: 'ada@example.com', otp: code })).body;
    await api().post('/api/v1/auth/password/reset').send({ resetToken, newPassword: 'Br4ndNewPass!' });
    await settle();
    expect(byCategory('password-changed')).toEqual([
      expect.objectContaining({ to: 'ada@example.com', subject: 'Your Instant Doctor password was changed' }),
    ]);
  });
});
