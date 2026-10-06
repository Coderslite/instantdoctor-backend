import { describe, expect, it } from 'vitest';
import * as t from '../../src/integrations/mail/templates.js';

const stripTags = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
const numbersIn = (text: string) => [...text.matchAll(/\b\d{4,8}\b/g)].map((m) => m[0]);

describe('verification code email', () => {
  const mail = t.verificationCode({ code: '48213', purpose: 'register', firstName: 'Ada', expiresInMinutes: 10 });

  it('puts the code first in the subject', () => {
    expect(mail.subject).toBe('48213 is your Instant Doctor verification code');
  });

  it('states the code in a plain sentence in both parts', () => {
    expect(mail.text).toContain('Your verification code is 48213');
    expect(stripTags(mail.html)).toContain('Your verification code is  48213');
  });

  it('contains no other number that could be mistaken for the code', () => {
    expect(new Set(numbersIn(mail.text))).toEqual(new Set(['48213']));
    expect(new Set(numbersIn(stripTags(mail.html)))).toEqual(new Set(['48213']));
  });

  it('words the subject for each purpose', () => {
    expect(t.verificationCode({ code: '1', purpose: 'password_reset', expiresInMinutes: 10 }).subject).toBe(
      '1 is your Instant Doctor password reset code',
    );
    expect(t.verificationCode({ code: '1', purpose: 'login', expiresInMinutes: 10 }).subject).toBe(
      '1 is your Instant Doctor sign-in code',
    );
  });
});

describe('templates', () => {
  const hostile = '<script>alert(1)</script>';
  const all = {
    verificationCode: t.verificationCode({ code: '48213', purpose: 'register', firstName: hostile, expiresInMinutes: 10 }),
    welcome: t.welcome({ firstName: hostile }),
    signInAlert: t.signInAlert({ firstName: hostile, device: hostile, ipAddress: '10.0.0.1', at: new Date() }),
    passwordChanged: t.passwordChanged({ firstName: hostile, at: new Date() }),
    pharmacyNewOrder: t.pharmacyNewOrder({
      pharmacyName: hostile,
      trackingId: 'K7Q2M9XA',
      customerName: hostile,
      items: [{ name: hostile, quantity: 2 }],
      deliveryAddress: hostile,
    }),
    orderStatusUpdate: t.orderStatusUpdate({
      firstName: hostile,
      trackingId: 'K7Q2M9XA',
      status: 'delivering',
      items: [{ name: hostile, quantity: 1 }],
      total: '₦7,500',
    }),
    opsActivity: t.opsActivity({
      activity: hostile,
      user: { id: 'u1', name: hostile, email: 'a@b.co', phoneNumber: null, country: 'NG' },
      at: new Date(),
    }),
  };

  it.each(Object.entries(all))('%s escapes user-supplied text', (_name, mail) => {
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it.each(Object.entries(all))('%s has a subject, an HTML and a plain-text part', (_name, mail) => {
    expect(mail.subject.length).toBeGreaterThan(5);
    expect(mail.html).toMatch(/^<!DOCTYPE html>/);
    expect(mail.text.length).toBeGreaterThan(40);
    expect(mail.text.replaceAll(hostile, '')).not.toMatch(/<[a-z]/i);
  });
});
