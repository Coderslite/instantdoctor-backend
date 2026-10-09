import { env } from '../config/env.js';
import { serviceUnavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';

interface RateTable {
  rates: Record<string, number>;
  fetchedAt: number;
}

let cache: RateTable | null = null;
let inflight: Promise<RateTable> | null = null;

async function fetchRates(): Promise<RateTable> {
  const res = await fetch(env.EXCHANGE_RATE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Exchange rate API responded ${res.status}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  if (!body.rates || typeof body.rates.USD !== 'number') throw new Error('Malformed rate payload');
  return { rates: body.rates, fetchedAt: Date.now() };
}

/**
 * USD -> `currency` rate. Cached for EXCHANGE_RATE_TTL_SECONDS; if a refresh
 * fails, the last known table is served (stale-if-error) rather than failing checkout.
 */
export async function usdRate(currency: string): Promise<number> {
  const code = currency.toUpperCase();
  if (code === 'USD') return 1;

  const fresh = cache && Date.now() - cache.fetchedAt < env.EXCHANGE_RATE_TTL_SECONDS * 1000;
  if (!fresh) {
    inflight ??= fetchRates().finally(() => (inflight = null));
    try {
      cache = await inflight;
    } catch (err) {
      if (!cache) throw serviceUnavailable('Exchange rates are temporarily unavailable');
      logger.warn({ err }, 'Exchange rate refresh failed; serving stale rates');
    }
  }
  const rate = cache?.rates[code];
  if (typeof rate !== 'number' || rate <= 0) {
    throw serviceUnavailable(`No exchange rate available for ${code}`);
  }
  return rate;
}

/** Returns the FX multiplier to convert one unit of `source` into `target`. */
export async function currencyExchangeRate(source: string, target: string): Promise<number> {
  const from = source.toUpperCase();
  const to = target.toUpperCase();
  if (from === to) return 1;
  const [sourceUsdRate, targetUsdRate] = await Promise.all([usdRate(from), usdRate(to)]);
  return targetUsdRate / sourceUsdRate;
}

export function convertCurrencyAmount(amount: number, currency: string, rate: number): number {
  return fromMinorUnits(toMinorUnits(amount * rate, currency), currency);
}

export interface DoctorEarningFx {
  currency: string;
  rate: number;
  capturedAt: string;
}

export async function doctorEarningFx(source: string, target: string): Promise<DoctorEarningFx> {
  return {
    currency: target.toUpperCase(),
    rate: await currencyExchangeRate(source, target),
    capturedAt: new Date().toISOString(),
  };
}

/** Test hook. */
export function primeRates(rates: Record<string, number>) {
  cache = { rates: { USD: 1, ...rates }, fetchedAt: Date.now() };
}
