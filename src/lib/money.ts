/** Currencies with no minor unit (Stripe's list). */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV',
  'XAF', 'XOF', 'XPF',
]);

export const isZeroDecimal = (currency: string) => ZERO_DECIMAL.has(currency.toUpperCase());

/** Round half-up to 2 decimal places, avoiding binary float drift (1.005 -> 1.01). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Major units -> provider minor units (9.99 USD -> 999, 500 JPY -> 500). */
export function toMinorUnits(amount: number, currency: string): number {
  return isZeroDecimal(currency) ? Math.round(amount) : Math.round(round2(amount) * 100);
}

export function fromMinorUnits(amountMinor: number, currency: string): number {
  return isZeroDecimal(currency) ? amountMinor : round2(amountMinor / 100);
}
