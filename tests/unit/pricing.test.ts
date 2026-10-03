import { beforeAll, describe, expect, it } from 'vitest';
import { primeRates } from '../../src/integrations/exchange-rates.js';
import { quoteFromUsd, resolveRegion, roundUpForCurrency } from '../../src/modules/pricing/pricing.service.js';
import { doctorEarning, orderSurcharge, pharmacySplit, referralCommission } from '../../src/modules/pricing/fees.js';

describe('roundUpForCurrency', () => {
  it.each([
    [1234, 'NGN', 1300],
    [1200, 'NGN', 1200],
    [12_345, 'UGX', 13_000],
    [101, 'KES', 110],
    [9.01, 'USD', 10],
    [0, 'USD', 0],
  ])('%d %s -> %d', (price, currency, expected) => {
    expect(roundUpForCurrency(price, currency)).toBe(expected);
  });

  it('ignores float noise instead of bumping to the next step', () => {
    expect(roundUpForCurrency(20.000000001, 'USD')).toBe(20);
  });
});

describe('resolveRegion', () => {
  it('uses saved currency, else maps country, else USD', () => {
    expect(resolveRegion({ country: 'NG', currency: null })).toEqual({ country: 'NG', currency: 'NGN' });
    expect(resolveRegion({ country: 'ng', currency: 'usd' })).toEqual({ country: 'NG', currency: 'USD' });
    expect(resolveRegion({ country: null, currency: null })).toEqual({ country: 'US', currency: 'USD' });
  });

  it('infers a missing country from an unambiguous currency only', () => {
    expect(resolveRegion({ country: null, currency: 'ZAR' })).toEqual({ country: 'ZA', currency: 'ZAR' });
    expect(resolveRegion({ country: null, currency: 'EUR' })).toEqual({ country: 'US', currency: 'EUR' });
  });
});

describe('quoteFromUsd', () => {
  beforeAll(() => primeRates({ NGN: 1500, GBP: 0.8 }));

  it('applies the 50% regional discount, FX and rounding for African countries', async () => {
    const quote = await quoteFromUsd(10, { country: 'NG', currency: 'NGN' });
    expect(quote).toMatchObject({ amount: 7500, currency: 'NGN', amountUsd: 5, discountApplied: true });
  });

  it('charges full price elsewhere', async () => {
    const quote = await quoteFromUsd(10, { country: 'GB', currency: 'GBP' });
    expect(quote).toMatchObject({ amount: 8, currency: 'GBP', amountUsd: 10, discountApplied: false });
  });
});

describe('fees', () => {
  it('splits consultation revenue 60/40', () => expect(doctorEarning(1000)).toBe(600));
  it('adds a 2% surcharge on goods only', () => expect(orderSurcharge(5000)).toBe(100));
  it('gives the pharmacy goods + delivery minus 5% of goods', () => {
    expect(pharmacySplit(10_000, 500)).toEqual({ pharmacyEarning: 10_000, platformEarning: 500 });
  });
  it('pays 10% referral commission', () => expect(referralCommission(6800)).toBe(680));
});
