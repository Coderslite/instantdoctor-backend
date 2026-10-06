import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { users } from '../../src/db/schema/index.js';
import { primeRates } from '../../src/integrations/exchange-rates.js';
import { quoteFromUsd, resolveRegion } from '../../src/modules/pricing/pricing.service.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const me = (token: string) => api().get('/api/v1/users/me').set(auth(token));
const patch = (token: string, body: object) => api().patch('/api/v1/users/me').set(auth(token)).send(body);

describe('profile completion', () => {
  beforeEach(() => resetDatabase());

  it('reports country and phone as missing for a social sign-up', async () => {
    const user = await createUser({ country: null, currency: null, phoneNumber: null });
    expect((await me(user.token)).body.profileCompletion).toEqual({ complete: false, missing: ['country', 'phoneNumber'] });
  });

  it('treats malformed stored phone numbers as missing', async () => {
    const user = await createUser({ country: 'NG', currency: 'NGN', phoneNumber: '+1+923374733' });
    expect((await me(user.token)).body.profileCompletion.missing).toEqual(['phoneNumber']);
  });

  it('accepts a valid local number already on file for the user\'s country', async () => {
    const user = await createUser({ country: 'NG', currency: 'NGN', phoneNumber: '08105862370' });
    expect((await me(user.token)).body.profileCompletion).toEqual({ complete: true, missing: [] });
  });

  it('completes the profile and stores the phone in international format', async () => {
    const user = await createUser({ country: null, currency: null, phoneNumber: null });
    const res = await patch(user.token, { country: 'NG', currency: 'NGN', phoneNumber: '0810 586 2370' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ country: 'NG', currency: 'NGN', phoneNumber: '+2348105862370' });
    expect(res.body.profileCompletion).toEqual({ complete: true, missing: [] });
  });

  it('validates the phone against the country already on the profile', async () => {
    const user = await createUser({ country: 'GB', currency: 'GBP', phoneNumber: null });
    const res = await patch(user.token, { phoneNumber: '07400 123456' });
    expect(res.body.phoneNumber).toBe('+447400123456');
  });

  it('rejects invalid phone numbers and unknown countries', async () => {
    const user = await createUser({ country: 'NG', currency: 'NGN', phoneNumber: null });
    expect((await patch(user.token, { phoneNumber: '12345' })).status).toBe(400);
    expect((await patch(user.token, { country: 'XX' })).status).toBe(400);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.phoneNumber).toBeNull();
  });

  it('sign-up stores the phone in international format and rejects invalid numbers', async () => {
    const body = {
      email: 'new@example.com',
      password: 'Sup3rSecret!',
      firstName: 'Ada',
      lastName: 'Obi',
      gender: 'Female',
    };
    expect((await api().post('/api/v1/auth/register').send({ ...body, phoneNumber: '12345' })).status).toBe(400);
    expect((await api().post('/api/v1/auth/register').send({ ...body, phoneNumber: '+234 810 586 2370' })).status).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.email, 'new@example.com'));
    expect(row!.phoneNumber).toBe('+2348105862370');
  });
});

describe('pricing without a country', () => {
  it('gives the African discount for shared African currencies', async () => {
    expect(resolveRegion({ country: null, currency: 'XAF' })).toEqual({ country: 'CM', currency: 'XAF' });
    expect(resolveRegion({ country: null, currency: 'XOF' }).country).toBe('SN');
    primeRates({ XAF: 600 });
    const quote = await quoteFromUsd(10, resolveRegion({ country: null, currency: 'XAF' }));
    expect(quote.discountApplied).toBe(true);
  });
});
