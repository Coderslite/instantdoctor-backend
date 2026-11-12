import { and, count, desc, eq, gte, like, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { DOWNLOAD_STORES, downloadClicks } from '../../db/schema/index.js';
import { affectedRows } from '../../lib/db-errors.js';
import { paginationQuery } from '../../lib/pagination.js';
import { BOT_UA, deviceOf, locate, sourceOf, visitorHash, type RequestInfo } from '../blog/blog.analytics.js';

// ── Collecting clicks ───────────────────────────────────────────────────────

const text = (max: number) =>
  z
    .string()
    .trim()
    .transform((s) => s.slice(0, max) || undefined)
    .optional();

/** What the website sends when a store badge is clicked. Only the store is required. */
export const clickBeacon = z.object({
  clickId: z.uuid().optional(),
  store: z.enum(DOWNLOAD_STORES),
  utmSource: text(100),
  utmMedium: text(100),
  utmCampaign: text(191),
  utmId: text(100),
  referrer: z.string().max(2048).optional(),
  page: text(255),
});
export type ClickBeacon = z.infer<typeof clickBeacon>;

export function osOf(userAgent: string): (typeof downloadClicks.os.enumValues)[number] {
  if (/Android/i.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  if (/Linux|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

const hostOf = (url: string | undefined) => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().slice(0, 255) || null;
  } catch {
    return null;
  }
};

/** Stores one badge click with where it came from. Bots are ignored; a repeated clickId is counted once. */
export async function recordClick(beacon: ClickBeacon, info: RequestInfo) {
  if (!info.userAgent || BOT_UA.test(info.userAgent)) return { counted: false };
  const { country, region, city } = locate(info);
  const inserted = await db
    .insert(downloadClicks)
    .ignore()
    .values({
      clickId: beacon.clickId ?? crypto.randomUUID(),
      store: beacon.store,
      source: sourceOf(beacon.referrer, beacon.utmSource, info.origin),
      medium: beacon.utmMedium ?? null,
      campaign: beacon.utmCampaign ?? null,
      campaignId: beacon.utmId ?? null,
      referrer: hostOf(beacon.referrer),
      page: beacon.page ?? null,
      device: deviceOf(info.userAgent),
      os: osOf(info.userAgent),
      country,
      region,
      city,
      visitorHash: visitorHash(info.ip, info.userAgent),
      userAgent: info.userAgent.slice(0, 500),
    });
  return { counted: affectedRows(inserted) > 0 };
}

// ── Reporting ───────────────────────────────────────────────────────────────

export const reportQuery = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90, 365].includes(d), 'days must be 7, 30, 90 or 365').default(30),
  /** The viewer's UTC offset in minutes (e.g. 60 for WAT), so daily buckets match their calendar. */
  tzOffset: z.coerce.number().int().min(-720).max(840).default(60),
});
export type ReportQuery = z.infer<typeof reportQuery>;

const clicks = sql<number>`count(*)`.mapWith(Number);
const visitors = sql<number>`count(distinct ${downloadClicks.visitorHash})`.mapWith(Number);
const android = sql<number>`coalesce(sum(${downloadClicks.store} = 'android'), 0)`.mapWith(Number);
const ios = sql<number>`coalesce(sum(${downloadClicks.store} = 'ios'), 0)`.mapWith(Number);

export async function report(query: ReportQuery) {
  const now = new Date();
  const from = new Date(now.getTime() - query.days * 86_400_000);
  const prevFrom = new Date(from.getTime() - query.days * 86_400_000);
  const inRange = gte(downloadClicks.createdAt, from);
  const offset = `${query.tzOffset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(query.tzOffset) / 60)).padStart(2, '0')}:${String(Math.abs(query.tzOffset) % 60).padStart(2, '0')}`;
  const localDay = sql<string>`date_format(convert_tz(${downloadClicks.createdAt}, '+00:00', ${offset}), '%Y-%m-%d')`;

  const totalsFor = (where: SQL | undefined) =>
    db
      .select({ clicks, visitors, android, ios })
      .from(downloadClicks)
      .where(where)
      .then(([r]) => r ?? { clicks: 0, visitors: 0, android: 0, ios: 0 });
  const grouped = <T extends Record<string, AnyMySqlColumn>>(cols: T, limit: number) =>
    db
      .select({ ...cols, clicks, visitors, android, ios })
      .from(downloadClicks)
      .where(inRange)
      .groupBy(...Object.values(cols))
      .orderBy(desc(clicks))
      .limit(limit);

  const [totals, previous, daily, sources, campaigns, countries, devices, pages] = await Promise.all([
    totalsFor(inRange),
    totalsFor(and(gte(downloadClicks.createdAt, prevFrom), lt(downloadClicks.createdAt, from))),
    db.select({ date: localDay, clicks, android, ios }).from(downloadClicks).where(inRange).groupBy(sql`1`).orderBy(sql`1`),
    grouped({ source: downloadClicks.source }, 25),
    grouped(
      { source: downloadClicks.source, medium: downloadClicks.medium, campaign: downloadClicks.campaign, campaignId: downloadClicks.campaignId },
      50,
    ),
    grouped({ country: downloadClicks.country }, 40),
    grouped({ os: downloadClicks.os }, 6),
    grouped({ page: downloadClicks.page }, 15),
  ]);

  // Every day in the range gets a point, including days with no clicks.
  const byDay = new Map(daily.map((d) => [d.date, d]));
  const series = Array.from({ length: query.days }, (_, i) => {
    const local = new Date(now.getTime() + query.tzOffset * 60_000 - (query.days - 1 - i) * 86_400_000);
    const date = local.toISOString().slice(0, 10);
    const day = byDay.get(date);
    return { date, clicks: day?.clicks ?? 0, android: day?.android ?? 0, ios: day?.ios ?? 0 };
  });

  return {
    range: { days: query.days, from: from.toISOString(), to: now.toISOString() },
    totals,
    previous,
    series,
    sources: sources.map((s) => ({ ...s, source: s.source ?? 'direct' })),
    campaigns: campaigns.map((c) => ({ ...c, source: c.source ?? 'direct' })),
    countries,
    devices,
    pages: pages.map((p) => ({ ...p, page: p.page ?? 'unknown' })),
  };
}

export const listQuery = paginationQuery.extend({
  store: z.enum(DOWNLOAD_STORES).optional(),
  /** "direct" matches clicks with no known source. */
  source: z.string().trim().max(120).optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

/** Individual clicks, newest first. */
export async function listClicks(query: ListQuery) {
  const filters: SQL[] = [];
  if (query.store) filters.push(eq(downloadClicks.store, query.store));
  if (query.source) filters.push(query.source === 'direct' ? sql`${downloadClicks.source} is null` : eq(downloadClicks.source, query.source));
  if (query.search) {
    const term = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
    filters.push(
      or(
        like(downloadClicks.source, term),
        like(downloadClicks.campaign, term),
        like(downloadClicks.campaignId, term),
        like(downloadClicks.medium, term),
        like(downloadClicks.referrer, term),
        like(downloadClicks.city, term),
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const [items, [total]] = await Promise.all([
    db
      .select({
        id: downloadClicks.id,
        store: downloadClicks.store,
        source: downloadClicks.source,
        medium: downloadClicks.medium,
        campaign: downloadClicks.campaign,
        campaignId: downloadClicks.campaignId,
        referrer: downloadClicks.referrer,
        page: downloadClicks.page,
        device: downloadClicks.device,
        os: downloadClicks.os,
        country: downloadClicks.country,
        region: downloadClicks.region,
        city: downloadClicks.city,
        userAgent: downloadClicks.userAgent,
        imported: sql<boolean>`${downloadClicks.legacyId} is not null`.mapWith(Boolean),
        createdAt: downloadClicks.createdAt,
      })
      .from(downloadClicks)
      .where(where)
      .orderBy(desc(downloadClicks.createdAt), desc(downloadClicks.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(downloadClicks).where(where),
  ]);
  return { items, total: total?.total ?? 0, limit: query.limit, offset: query.offset };
}
