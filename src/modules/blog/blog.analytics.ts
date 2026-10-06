import { createHash } from 'node:crypto';
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { allCountries } from 'country-region-data';
import geoip from 'geoip-lite';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { blogPostViews, healthTips } from '../../db/schema/index.js';
import { affectedRows } from '../../lib/db-errors.js';
import { isLive } from './blog.service.js';

// ── Collecting views ────────────────────────────────────────────────────────

/** What the website sends with a view. Every field is optional so old pages keep counting. */
export const viewBeacon = z.object({
  viewId: z.uuid().optional(),
  referrer: z.string().max(2048).optional(),
  utmSource: z.string().max(100).optional(),
});
export const engagementBeacon = z.object({
  viewId: z.uuid(),
  /** Seconds the page was visible; capped so an open tab left overnight doesn't skew averages. */
  seconds: z.coerce.number().int().min(0).transform((s) => Math.min(s, 1800)),
  scroll: z.coerce.number().int().min(0).max(100),
});

export type RequestInfo = {
  ip: string | undefined;
  userAgent: string;
  /** The website's origin (from the Origin header), used to tell internal clicks from referrals. */
  origin: string | undefined;
  headers: Record<string, string | string[] | undefined>;
};

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios|node-fetch/i;

/** Region names by country and ISO 3166-2 subdivision code, for every country. */
const REGION_NAMES = new Map(allCountries.map(([, code, regions]) => [code as string, new Map(regions.map(([name, short]) => [short, name]))]));
/** Codes GeoIP reports that the dataset lists differently: UK nations and South Africa's current Gauteng code. */
const REGION_OVERRIDES: Record<string, string> = {
  'GB-ENG': 'England', 'GB-SCT': 'Scotland', 'GB-WLS': 'Wales', 'GB-NIR': 'Northern Ireland', 'ZA-GP': 'Gauteng',
};
const header = (h: RequestInfo['headers'], name: string) => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
};

/** Country/region/city: a CDN's geo headers when present, otherwise the bundled GeoLite database. */
export function locate(info: RequestInfo): { country: string | null; region: string | null; city: string | null } {
  const cdnCountry = header(info.headers, 'cf-ipcountry') ?? header(info.headers, 'x-vercel-ip-country');
  if (cdnCountry && /^[A-Z]{2}$/.test(cdnCountry) && cdnCountry !== 'XX' && cdnCountry !== 'T1') {
    const region = header(info.headers, 'x-vercel-ip-country-region') ?? header(info.headers, 'cf-region') ?? null;
    const city = header(info.headers, 'x-vercel-ip-city') ?? header(info.headers, 'cf-ipcity') ?? null;
    return { country: cdnCountry, region: regionName(cdnCountry, region), city: city ? safeDecode(city) : null };
  }
  const hit = info.ip ? geoip.lookup(info.ip.replace(/^::ffff:/, '')) : null;
  if (!hit?.country) return { country: null, region: null, city: null };
  return { country: hit.country, region: regionName(hit.country, hit.region || null), city: hit.city || null };
}

function regionName(country: string, region: string | null) {
  if (!region) return null;
  const code = region.toUpperCase();
  return (REGION_OVERRIDES[`${country}-${code}`] ?? REGION_NAMES.get(country)?.get(code) ?? region).slice(0, 100);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value).slice(0, 100);
  } catch {
    return value.slice(0, 100);
  }
}

export function deviceOf(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

const SOURCE_ALIASES: [RegExp, string][] = [
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)yahoo\.[a-z.]+$/, 'yahoo'],
  [/(^|\.)(facebook\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/^(t\.co|(.+\.)?(twitter|x)\.com)$/, 'x'],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, 'linkedin'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'youtube'],
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$/, 'chatgpt'],
];

/** "google", "facebook", a referring host, "internal" (from another page of the site) or null (direct). */
export function sourceOf(referrer: string | undefined, utmSource: string | undefined, origin: string | undefined) {
  const utm = utmSource?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 60);
  if (utm) return utm;
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  const siteHosts = [origin, env.WEBSITE_URL].flatMap((u) => {
    try {
      return u ? [new URL(u).hostname.replace(/^www\./, '')] : [];
    } catch {
      return [];
    }
  });
  if (siteHosts.includes(host)) return 'internal';
  return SOURCE_ALIASES.find(([re]) => re.test(host))?.[1] ?? host.slice(0, 120);
}

/** SHA-256 of IP + user agent + a salt that changes every UTC day. Not reversible, not linkable across days. */
export function visitorHash(ip: string | undefined, userAgent: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return createHash('sha256').update(`${env.JWT_ACCESS_SECRET}|blog-visitor|${day}|${ip ?? ''}|${userAgent}`).digest('hex');
}

/** Counts a view of a live post and stores where it came from. Bots are ignored. Returns whether it was counted. */
export async function recordView(slug: string, beacon: z.infer<typeof viewBeacon>, info: RequestInfo) {
  if (!info.userAgent || BOT_UA.test(info.userAgent)) return { counted: false };
  const [post] = await db.select({ id: healthTips.id }).from(healthTips).where(and(isLive(), eq(healthTips.slug, slug))).limit(1);
  if (!post) return { counted: false };

  const { country, region, city } = locate(info);
  const inserted = await db
    .insert(blogPostViews)
    .ignore() // A repeated viewId (a retried beacon) must not double-count.
    .values({
      postId: post.id,
      viewId: beacon.viewId ?? crypto.randomUUID(),
      visitorHash: visitorHash(info.ip, info.userAgent),
      country,
      region,
      city,
      source: sourceOf(beacon.referrer, beacon.utmSource, info.origin),
      device: deviceOf(info.userAgent),
    });
  if (affectedRows(inserted) === 0) return { counted: false };

  await db
    .update(healthTips)
    .set({ views: sql`${healthTips.views} + 1`, updatedAt: sql`${healthTips.updatedAt}` })
    .where(eq(healthTips.id, post.id));
  return { counted: true };
}

/** Records how long a view lasted and how far the reader scrolled. Only ever increases the stored values. */
export async function recordEngagement(beacon: z.infer<typeof engagementBeacon>) {
  const recent = new Date(Date.now() - 6 * 60 * 60 * 1000);
  await db
    .update(blogPostViews)
    .set({
      engagedSeconds: sql`GREATEST(COALESCE(${blogPostViews.engagedSeconds}, 0), ${beacon.seconds})`,
      scrollDepth: sql`GREATEST(COALESCE(${blogPostViews.scrollDepth}, 0), ${beacon.scroll})`,
    })
    .where(and(eq(blogPostViews.viewId, beacon.viewId), gte(blogPostViews.createdAt, recent)));
  return { recorded: true };
}

// ── Reporting ───────────────────────────────────────────────────────────────

export const analyticsQuery = z.object({
  days: z.coerce.number().int().refine((d) => [7, 30, 90, 365].includes(d), 'days must be 7, 30, 90 or 365').default(30),
  postId: z.string().max(36).optional(),
  /** The viewer's UTC offset in minutes (e.g. 60 for WAT), so daily buckets match their calendar. */
  tzOffset: z.coerce.number().int().min(-720).max(840).default(60),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuery>;

/** A view counts as "read" when the reader got at least this far down the article. */
const READ_DEPTH = 75;

const views = sql<number>`count(*)`.mapWith(Number);
const visitors = sql<number>`count(distinct ${blogPostViews.visitorHash})`.mapWith(Number);
const avgSeconds = sql<number>`coalesce(round(avg(${blogPostViews.engagedSeconds})), 0)`.mapWith(Number);
const readRate = sql<number>`coalesce(round(100 * sum(${blogPostViews.scrollDepth} >= ${READ_DEPTH}) / nullif(count(${blogPostViews.scrollDepth}), 0)), 0)`.mapWith(Number);

export async function analytics(query: AnalyticsQuery) {
  const now = new Date();
  const from = new Date(now.getTime() - query.days * 86_400_000);
  const prevFrom = new Date(from.getTime() - query.days * 86_400_000);
  const postFilter = query.postId ? eq(blogPostViews.postId, query.postId) : undefined;
  const inRange = and(gte(blogPostViews.createdAt, from), postFilter);
  const offset = `${query.tzOffset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(query.tzOffset) / 60)).padStart(2, '0')}:${String(Math.abs(query.tzOffset) % 60).padStart(2, '0')}`;
  const localDay = sql<string>`date_format(convert_tz(${blogPostViews.createdAt}, '+00:00', ${offset}), '%Y-%m-%d')`;

  const totalsFor = (where: SQL | undefined) =>
    db.select({ views, visitors, avgSeconds, readRate }).from(blogPostViews).where(where).then(([r]) => r ?? { views: 0, visitors: 0, avgSeconds: 0, readRate: 0 });
  const grouped = <T extends Record<string, AnyMySqlColumn>>(cols: T, by: AnyMySqlColumn[], limit: number) =>
    db
      .select({ ...cols, views, visitors })
      .from(blogPostViews)
      .where(inRange)
      .groupBy(...by)
      .orderBy(desc(views))
      .limit(limit);

  const [totals, previous, daily, topPosts, countries, regions, cities, sources, devices] = await Promise.all([
    totalsFor(inRange),
    totalsFor(and(gte(blogPostViews.createdAt, prevFrom), lt(blogPostViews.createdAt, from), postFilter)),
    db.select({ date: localDay, views, visitors }).from(blogPostViews).where(inRange).groupBy(localDay).orderBy(localDay),
    db
      .select({ id: healthTips.id, title: healthTips.title, slug: healthTips.slug, views, visitors, avgSeconds, readRate })
      .from(blogPostViews)
      .innerJoin(healthTips, eq(healthTips.id, blogPostViews.postId))
      .where(inRange)
      .groupBy(healthTips.id, healthTips.title, healthTips.slug)
      .orderBy(desc(views))
      .limit(50),
    grouped({ country: blogPostViews.country }, [blogPostViews.country], 60),
    grouped({ country: blogPostViews.country, region: blogPostViews.region }, [blogPostViews.country, blogPostViews.region], 40),
    grouped({ country: blogPostViews.country, region: blogPostViews.region, city: blogPostViews.city }, [blogPostViews.country, blogPostViews.region, blogPostViews.city], 40),
    grouped({ source: blogPostViews.source }, [blogPostViews.source], 25),
    grouped({ device: blogPostViews.device }, [blogPostViews.device], 3),
  ]);

  // Every day in the range gets a point, including days with no views.
  const byDay = new Map(daily.map((d) => [d.date, d]));
  const series = Array.from({ length: query.days }, (_, i) => {
    const local = new Date(now.getTime() + query.tzOffset * 60_000 - (query.days - 1 - i) * 86_400_000);
    const date = local.toISOString().slice(0, 10);
    return { date, views: byDay.get(date)?.views ?? 0, visitors: byDay.get(date)?.visitors ?? 0 };
  });

  return {
    range: { days: query.days, from: from.toISOString(), to: now.toISOString(), postId: query.postId ?? null },
    readDepth: READ_DEPTH,
    totals,
    previous,
    series,
    topPosts,
    countries,
    regions: regions.filter((r) => r.region),
    cities: cities.filter((c) => c.city),
    sources: sources.map((s) => ({ ...s, source: s.source ?? 'direct' })),
    devices,
  };
}
