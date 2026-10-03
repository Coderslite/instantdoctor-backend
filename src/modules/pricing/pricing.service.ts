import { round2 } from '../../lib/money.js';
import { usdRate } from '../../integrations/exchange-rates.js';

/** ISO country codes that receive the 50% regional discount. */
export const AFRICAN_COUNTRIES = new Set([
  'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CD', 'CG', 'DJ', 'EG', 'GQ',
  'ER', 'SZ', 'ET', 'GA', 'GM', 'GH', 'GN', 'GW', 'CI', 'KE', 'LS', 'LR', 'LY', 'MG', 'MW', 'ML',
  'MR', 'MU', 'MA', 'MZ', 'NA', 'NE', 'NG', 'RW', 'ST', 'SN', 'SC', 'SL', 'SO', 'ZA', 'SS', 'SD',
  'TZ', 'TG', 'TN', 'UG', 'ZM', 'ZW',
]);

const COUNTRY_CURRENCY: Record<string, string> = {
  NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR', TZ: 'TZS', UG: 'UGX', RW: 'RWF', EG: 'EGP',
  GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', IE: 'EUR', CH: 'CHF',
  US: 'USD', CA: 'CAD', BR: 'BRL', MX: 'MXN',
  JP: 'JPY', CN: 'CNY', IN: 'INR', AU: 'AUD', NZ: 'NZD', SG: 'SGD', MY: 'MYR', KR: 'KRW',
  AE: 'AED', SA: 'SAR', QA: 'QAR', TR: 'TRY',
};

export const AFRICAN_DISCOUNT_RATE = 0.5;

export interface Region {
  country: string;
  currency: string;
}

/** Currencies used by exactly one country in the map above (EUR is excluded: many countries). */
const CURRENCY_COUNTRY: Record<string, string> = Object.fromEntries(
  Object.entries(
    Object.entries(COUNTRY_CURRENCY).reduce<Record<string, string[]>>((acc, [country, currency]) => {
      (acc[currency] ??= []).push(country);
      return acc;
    }, {}),
  )
    .filter(([, countries]) => countries.length === 1)
    .map(([currency, countries]) => [currency, countries[0]!]),
);

/**
 * The pricing region for a user: saved country/currency; a missing country is
 * inferred from an unambiguous currency (ZAR -> ZA); otherwise US/USD.
 */
export function resolveRegion(user: { country: string | null; currency: string | null }): Region {
  const savedCurrency = user.currency?.trim().toUpperCase() || null;
  const country =
    user.country?.trim().toUpperCase() || (savedCurrency && CURRENCY_COUNTRY[savedCurrency]) || 'US';
  const currency = savedCurrency ?? COUNTRY_CURRENCY[country] ?? 'USD';
  return { country, currency };
}

/** Rounds a converted price up to a "clean" local amount, per currency convention. */
export function roundUpForCurrency(price: number, currency: string): number {
  if (price <= 0) return 0;
  const step =
    {
      NGN: 100, JPY: 100,
      UGX: 1000, TZS: 1000, RWF: 1000, KRW: 1000,
      INR: 10, KES: 10, GHS: 10, ZAR: 10, EGP: 10, TRY: 10,
    }[currency.toUpperCase()] ?? 1;
  // Round to cents first so float noise (e.g. 20.000000001) doesn't bump to the next step.
  return Math.ceil(round2(price) / step) * step;
}

export interface Quote {
  /** Amount to charge, in the region's currency. */
  amount: number;
  currency: string;
  /** USD price after the regional discount (for reporting). */
  amountUsd: number;
  exchangeRate: number;
  discountApplied: boolean;
}

/**
 * Converts a USD base price into the customer's local price:
 * regional discount -> FX conversion -> round up to a clean amount.
 */
export async function quoteFromUsd(baseUsd: number, region: Region): Promise<Quote> {
  const discountApplied = AFRICAN_COUNTRIES.has(region.country);
  const amountUsd = round2(discountApplied ? baseUsd * (1 - AFRICAN_DISCOUNT_RATE) : baseUsd);
  const exchangeRate = await usdRate(region.currency);
  return {
    amount: roundUpForCurrency(amountUsd * exchangeRate, region.currency),
    currency: region.currency,
    amountUsd,
    exchangeRate,
    discountApplied,
  };
}
