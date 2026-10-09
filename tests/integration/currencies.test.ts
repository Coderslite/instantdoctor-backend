import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { primeRates } from '../../src/integrations/exchange-rates.js';
import { api, auth, createDoctor, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

describe('supported earning currencies', () => {
  beforeEach(async () => {
    await resetDatabase();
    primeRates({ NGN: 1500, GBP: 0.8, EUR: 0.9 });
  });

  it('includes USD, EUR, and GBP in the public currency list', async () => {
    const response = await api().get('/api/v1/currencies').expect(200);
    const codes = response.body.items.map((item: { code: string }) => item.code);
    expect(codes).toEqual(expect.arrayContaining(['USD', 'EUR', 'GBP']));
  });

  it.each(['USD', 'EUR', 'GBP'])('lets doctors select %s as their earning currency', async (currency) => {
    const doctor = await createDoctor();
    const response = await api()
      .patch('/api/v1/users/me')
      .set(auth(doctor.token))
      .send({ earningCurrency: currency })
      .expect(200);
    expect(response.body.earningCurrency).toBe(currency);
  });
});
