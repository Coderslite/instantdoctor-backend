import { bigint, char, index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt } from '../columns.js';

export const DOWNLOAD_STORES = ['android', 'ios'] as const;
export type DownloadStore = (typeof DOWNLOAD_STORES)[number];

/**
 * One click on a Play Store / App Store badge on the website (the /app landing
 * page and anywhere else the badges appear). Records where the visitor came
 * from; no IP address is stored.
 */
export const downloadClicks = mysqlTable(
  'download_clicks',
  {
    id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
    /** Random id from the page, so a retried beacon is counted once. */
    clickId: char('click_id', { length: 36 }).notNull(),
    /** The badge clicked. */
    store: mysqlEnum('store', DOWNLOAD_STORES).notNull(),
    /** utm_source, else the referring site ("google", "facebook", a host), "internal", or null for direct. */
    source: varchar('source', { length: 120 }),
    medium: varchar('medium', { length: 100 }),
    campaign: varchar('campaign', { length: 191 }),
    /** utm_id, e.g. a Google Ads campaign id. */
    campaignId: varchar('campaign_id', { length: 100 }),
    /** Host of the referring page, e.g. "www.google.com". */
    referrer: varchar('referrer', { length: 255 }),
    /** The website page the badge was on, e.g. "/app". */
    page: varchar('page', { length: 255 }),
    device: mysqlEnum('device', ['mobile', 'tablet', 'desktop']).notNull(),
    os: mysqlEnum('os', ['android', 'ios', 'windows', 'mac', 'linux', 'other']).notNull(),
    country: char('country', { length: 2 }),
    region: varchar('region', { length: 100 }),
    city: varchar('city', { length: 100 }),
    /** Daily-salted hash of IP + user agent: counts unique visitors without storing either. */
    visitorHash: char('visitor_hash', { length: 64 }).notNull(),
    userAgent: varchar('user_agent', { length: 500 }),
    /** Row id in the website's old `campaigns` table, for clicks imported from it. */
    legacyId: int('legacy_id', { unsigned: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('download_clicks_click_uq').on(t.clickId),
    uniqueIndex('download_clicks_legacy_uq').on(t.legacyId),
    index('download_clicks_created_idx').on(t.createdAt),
    index('download_clicks_source_created_idx').on(t.source, t.createdAt),
  ],
);
