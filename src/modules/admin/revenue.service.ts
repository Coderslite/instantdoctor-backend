import { and, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  appointments,
  hmoCapitationLines,
  hmoClaims,
  hmoInvoices,
  labResults,
  orderCheckouts,
  orders,
  payments,
} from '../../db/schema/index.js';
import { usdRate } from '../../integrations/exchange-rates.js';
import { logger } from '../../lib/logger.js';
import { round2 } from '../../lib/money.js';
import { serviceStands } from '../hmo/hmo.claims.js';

/**
 * What Instant Doctor itself earns, by stream and in each original currency.
 * Amounts are never added across currencies; a naira equivalent at today's
 * rates is given alongside for the headline and the trend.
 *
 * - Consultations: what the patient paid less the doctor's fee (negative for a
 *   Family Care visit, whose income is the subscription); a refunded booking
 *   keeps only what wasn't refunded, and its doctor isn't paid.
 * - Lab reviews: the whole fee.
 * - Pharmacy: the platform's cut of the goods plus the customer service charge
 *   (refunded orders excluded). The pharmacy keeps the rest and the delivery fee.
 * - Family Care: membership payments.
 * - HMO billing: the HMO's share of consultations and lab reviews that took
 *   place. Medicine claims only repay what we advanced to the pharmacy, so they
 *   aren't income.
 * - HMO capitation: monthly capitation on invoices that weren't cancelled.
 */

export const REVENUE_STREAMS = ['consultations', 'lab_reviews', 'pharmacy', 'family_care', 'hmo_billing', 'hmo_capitation'] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];

const LABELS: Record<RevenueStream, { label: string; detail: string }> = {
  consultations: { label: 'Consultations', detail: 'Paid by patients, less doctor fees and refunds' },
  lab_reviews: { label: 'Lab result reviews', detail: 'Interpretation fees' },
  pharmacy: { label: 'Pharmacy orders', detail: 'Commission on medicines plus the service charge' },
  family_care: { label: 'Family Care', detail: 'Membership payments' },
  hmo_billing: { label: 'HMO billing', detail: 'HMO share of consultations and lab reviews' },
  hmo_capitation: { label: 'HMO capitation', detail: 'Monthly per-member capitation invoiced' },
};

/** Lagos (WAT, UTC+1) month of a UTC timestamp column. */
const lagosMonth = (column: SQLWrapper) => sql<string>`DATE_FORMAT(DATE_ADD(${column}, INTERVAL 1 HOUR), '%Y-%m')`;

/** `amount` is what Instant Doctor keeps; `gross` is what was paid for it (by the customer or their HMO). */
type Row = { stream: RevenueStream; month: string; currency: string; amount: number; gross: number; count: number };

/** Every stream's earnings in [from, to), by Lagos month and currency. */
async function rows(from: Date, to: Date): Promise<Row[]> {
  const fromMonth = monthOf(from);
  const lastMonth = monthOf(new Date(to.getTime() - 1));
  const tag = (stream: RevenueStream) => (r: { month: string; currency: string | null; amount: string | number | null; gross: string | number | null; count: number }) => ({
    stream,
    month: r.month,
    currency: (r.currency ?? 'NGN').toUpperCase(),
    amount: round2(Number(r.amount ?? 0)),
    gross: round2(Number(r.gross ?? 0)),
    count: Number(r.count),
  });

  const doctorFee = sql`COALESCE(${appointments.doctorEarning}, ${appointments.price} * 0.6)`;
  // Bookings brought over from Firebase have no payment time: date them by when they were made.
  const paidOn = sql`COALESCE(${appointments.paidAt}, ${appointments.createdAt})`;
  const [consultations, labs, pharmacy, family, hmo, capitation] = await Promise.all([
    db
      .select({
        month: lagosMonth(paidOn),
        currency: appointments.currency,
        amount: sql<string>`SUM(CASE WHEN ${appointments.status} IN ('cancelled', 'deleted')
          THEN ${appointments.price} - COALESCE(${appointments.refundedAmount}, 0)
          ELSE ${appointments.price} - ${doctorFee} END)`,
        gross: sql<string>`SUM(${appointments.price} - COALESCE(${appointments.refundedAmount}, 0))`,
        count: sql<number>`COUNT(*)`,
      })
      .from(appointments)
      .where(and(eq(appointments.isPaid, true), eq(appointments.isTrial, false), gte(paidOn, from), lt(paidOn, to)))
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        month: lagosMonth(labResults.createdAt),
        currency: labResults.currency,
        amount: sql<string>`SUM(${labResults.price})`,
        gross: sql<string>`SUM(${labResults.price})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(labResults)
      .where(and(ne(labResults.status, 'awaiting_payment'), isNotNull(labResults.price), gte(labResults.createdAt, from), lt(labResults.createdAt, to)))
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        month: lagosMonth(orders.createdAt),
        currency: orderCheckouts.currency,
        // The checkout's service charge, shared across its orders by their goods.
        amount: sql<string>`SUM(COALESCE(${orders.platformEarning}, 0)
          + CASE WHEN ${orderCheckouts.subtotal} > 0 THEN COALESCE(${payments.surcharge}, 0) * ${orders.subtotal} / ${orderCheckouts.subtotal} ELSE 0 END)`,
        // Goods and delivery paid by the customer and their HMO, plus the service charge.
        gross: sql<string>`SUM(${orders.totalAmount}
          + CASE WHEN ${orderCheckouts.subtotal} > 0 THEN COALESCE(${payments.surcharge}, 0) * ${orders.subtotal} / ${orderCheckouts.subtotal} ELSE 0 END)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .innerJoin(orderCheckouts, eq(orderCheckouts.id, orders.checkoutId))
      .leftJoin(
        payments,
        and(eq(payments.purpose, 'order_checkout'), eq(payments.purposeRefId, orderCheckouts.id), eq(payments.status, 'succeeded')),
      )
      .where(and(notInArray(orders.status, ['awaiting_payment', 'cancelled']), gte(orders.createdAt, from), lt(orders.createdAt, to)))
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        month: lagosMonth(payments.paidAt),
        currency: payments.currency,
        amount: sql<string>`SUM(${payments.amount})`,
        gross: sql<string>`SUM(${payments.amount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(payments)
      .where(and(eq(payments.purpose, 'family_subscription'), eq(payments.status, 'succeeded'), gte(payments.paidAt, from), lt(payments.paidAt, to)))
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        month: lagosMonth(hmoClaims.serviceDate),
        currency: sql<string>`'NGN'`,
        amount: sql<string>`SUM(${hmoClaims.hmoAmount})`,
        gross: sql<string>`SUM(${hmoClaims.hmoAmount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(hmoClaims)
      .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
      .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
      .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
      .where(
        and(
          inArray(hmoClaims.status, ['unbilled', 'invoiced', 'paid']),
          ne(hmoClaims.service, 'medicines'),
          serviceStands(),
          gte(hmoClaims.serviceDate, from),
          lt(hmoClaims.serviceDate, to),
        ),
      )
      .groupBy(sql`1`, sql`2`),
    db
      .select({
        month: hmoCapitationLines.month,
        currency: sql<string>`'NGN'`,
        amount: sql<string>`SUM(${hmoCapitationLines.amount})`,
        gross: sql<string>`SUM(${hmoCapitationLines.amount})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(hmoCapitationLines)
      .innerJoin(hmoInvoices, eq(hmoInvoices.id, hmoCapitationLines.invoiceId))
      .where(and(ne(hmoInvoices.status, 'cancelled'), gte(hmoCapitationLines.month, fromMonth), sql`${hmoCapitationLines.month} <= ${lastMonth}`))
      .groupBy(hmoCapitationLines.month),
  ]);
  return [
    ...consultations.map(tag('consultations')),
    ...labs.map(tag('lab_reviews')),
    ...pharmacy.map(tag('pharmacy')),
    ...family.map(tag('family_care')),
    ...hmo.map(tag('hmo_billing')),
    ...capitation.map(tag('hmo_capitation')),
  ];
}

/** "2026-10" for a date, in Lagos. */
const monthOf = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 7);
const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000+01:00`);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** Naira per unit of each currency at today's rates; a currency without a rate is left out of the naira figures. */
export async function nairaRates(currencies: string[]) {
  const rates: Record<string, number> = { NGN: 1 };
  const missing: string[] = [];
  let ngnPerUsd: number | null = null;
  try {
    ngnPerUsd = await usdRate('NGN');
  } catch (err) {
    logger.warn({ err }, 'Revenue report: no NGN rate');
  }
  for (const currency of new Set(currencies)) {
    if (currency === 'NGN') continue;
    try {
      if (ngnPerUsd === null) throw new Error('No NGN rate');
      rates[currency] = ngnPerUsd / (await usdRate(currency));
    } catch {
      missing.push(currency);
    }
  }
  return { rates, missing };
}

type Totals = Record<string, number>;
const add = (into: Totals, currency: string, amount: number) => {
  into[currency] = round2((into[currency] ?? 0) + amount);
};
export const inNaira = (totals: Totals, rates: Record<string, number>) =>
  round2(Object.entries(totals).reduce((sum, [currency, amount]) => sum + (rates[currency] ? amount * rates[currency] : 0), 0));

/**
 * Revenue for a period (whole Lagos days, `to` inclusive) with a monthly trend
 * for the 12 months up to the period's end.
 */
export async function revenueReport(query: { from: string; to: string }) {
  const from = new Date(`${query.from}T00:00:00.000+01:00`);
  const to = new Date(new Date(`${query.to}T00:00:00.000+01:00`).getTime() + 24 * 3600_000);
  const lastMonth = monthOf(new Date(to.getTime() - 1));
  const trendFrom = addMonths(lastMonth, -11);
  const [period, trend] = await Promise.all([rows(from, to), rows(monthStart(trendFrom), monthStart(addMonths(lastMonth, 1)))]);
  const { rates, missing } = await nairaRates([...period, ...trend].map((r) => r.currency));

  const total: Totals = {};
  const collected: Totals = {};
  const streams = REVENUE_STREAMS.map((stream) => {
    const byCurrency: Totals = {};
    const grossByCurrency: Totals = {};
    let count = 0;
    for (const r of period.filter((row) => row.stream === stream)) {
      add(byCurrency, r.currency, r.amount);
      add(total, r.currency, r.amount);
      add(grossByCurrency, r.currency, r.gross);
      add(collected, r.currency, r.gross);
      count += r.count;
    }
    return { stream, ...LABELS[stream], byCurrency, ngnEquivalent: inNaira(byCurrency, rates), collected: { byCurrency: grossByCurrency, ngnEquivalent: inNaira(grossByCurrency, rates) }, count };
  });

  const months = Array.from({ length: 12 }, (_, i) => addMonths(trendFrom, i));
  const monthly = months.map((month) => {
    const byStream = Object.fromEntries(
      REVENUE_STREAMS.map((stream) => {
        const byCurrency: Totals = {};
        for (const r of trend.filter((row) => row.month === month && row.stream === stream)) add(byCurrency, r.currency, r.amount);
        return [stream, inNaira(byCurrency, rates)];
      }),
    ) as Record<RevenueStream, number>;
    return { month, byStream, ngnEquivalent: round2(Object.values(byStream).reduce((a, b) => a + b, 0)) };
  });

  return {
    from: query.from,
    to: query.to,
    total: { byCurrency: total, ngnEquivalent: inNaira(total, rates) },
    /** Everything paid for these services, before doctor and pharmacy shares. */
    collected: { byCurrency: collected, ngnEquivalent: inNaira(collected, rates) },
    streams,
    monthly,
    /** Naira per unit, at today's rates, used for every naira equivalent here. */
    rates: Object.fromEntries(Object.entries(rates).filter(([c]) => c !== 'NGN')),
    /** Currencies with income but no rate today: shown in their own currency only. */
    unconverted: missing,
  };
}
