/**
 * One-off import of download clicks the website logged in its old `campaigns`
 * table into `download_clicks`, so the admin "App downloads" page shows history.
 *
 *   npm run clicks:import -- --dry-run                       # count what would be imported
 *   npm run clicks:import                                    # local database
 *   npm run clicks:import:live -- --confirm-live             # write to the live database
 *
 * Options:
 *   --source-url=mysql://…   read `campaigns` from another database (default: the target database)
 *   --tz=+01:00              the time zone `campaigns.created_at` was written in (default +00:00)
 *
 * Safe to re-run: rows are matched on their old id (`legacy_id`) and skipped if already imported.
 * Rows whose platform isn't Android or iOS (no badge to attribute) are skipped and counted.
 */
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { closeDatabase, databaseConfig, databaseLabel, db } from '../src/db/client.js';
import { downloadClicks } from '../src/db/schema/index.js';
import { affectedRows } from '../src/lib/db-errors.js';
import { deviceOf } from '../src/modules/blog/blog.analytics.js';
import { osOf } from '../src/modules/download-clicks/download-clicks.service.js';

type LegacyRow = {
  id: number;
  utm_source: string | null;
  utm_medium: string | null;
  utm_id: string | null;
  utm_campaign: string | null;
  platform: string | null;
  user_agent: string | null;
  created_at: string | Date | null;
};

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dryRun = process.argv.includes('--dry-run');
const tz = arg('tz') ?? '+00:00';
if (!/^[+-]\d{2}:\d{2}$/.test(tz)) throw new Error('--tz must look like +01:00');

const blank = (v: string | null | undefined, max: number) => v?.trim().slice(0, max) || null;

function parseDate(value: LegacyRow['created_at']): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = value?.trim();
  if (!s) return null;
  // "2025-03-01 14:22:05" (no zone) is read in --tz; anything with a zone is taken as is.
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}${tz}` : s;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function storeOf(platform: string | null) {
  const p = platform?.toLowerCase() ?? '';
  if (p.includes('android')) return 'android' as const;
  if (p === 'ios' || p.includes('iphone') || p.includes('ipad')) return 'ios' as const;
  return null;
}

async function main() {
  if (databaseConfig.target === 'live' && !dryRun && !process.argv.includes('--confirm-live')) {
    throw new Error('Refusing to write to the LIVE database without --confirm-live (or use --dry-run)');
  }
  console.log(`Target: ${databaseLabel}${dryRun ? ' (dry run)' : ''}`);

  const sourceUrl = arg('source-url');
  const source = sourceUrl ? await mysql.createConnection({ uri: sourceUrl, dateStrings: true }) : null;
  const query = async (sqlText: string) =>
    source ? ((await source.query(sqlText))[0] as LegacyRow[]) : ((await db.execute(sqlText)) as unknown as [LegacyRow[]])[0];

  const rows = await query(
    'SELECT id, utm_source, utm_medium, utm_id, utm_campaign, platform, user_agent, created_at FROM campaigns ORDER BY id',
  );
  console.log(`Found ${rows.length} rows in campaigns${sourceUrl ? ' (separate source database)' : ''}`);

  const values: (typeof downloadClicks.$inferInsert)[] = [];
  let noStore = 0;
  let badDate = 0;
  for (const row of rows) {
    const store = storeOf(row.platform);
    if (!store) {
      noStore++;
      continue;
    }
    const createdAt = parseDate(row.created_at);
    if (!createdAt) {
      badDate++;
      continue;
    }
    const userAgent = row.user_agent?.trim() ?? '';
    values.push({
      clickId: `legacy-${row.id}`,
      legacyId: row.id,
      store,
      source: blank(row.utm_source?.toLowerCase().replace(/[^a-z0-9._-]/g, ''), 60),
      medium: blank(row.utm_medium, 100),
      campaign: blank(row.utm_campaign, 191),
      campaignId: blank(row.utm_id, 100),
      page: '/app',
      device: deviceOf(userAgent),
      os: osOf(userAgent),
      // No IP was kept, so each old click counts as its own visitor.
      visitorHash: createHash('sha256').update(`legacy-campaign-${row.id}`).digest('hex'),
      userAgent: blank(userAgent, 500),
      createdAt,
    });
  }
  console.log(`Importable: ${values.length} · skipped (not Android/iOS): ${noStore} · skipped (unreadable date): ${badDate}`);

  let imported = 0;
  if (!dryRun) {
    for (let i = 0; i < values.length; i += 500) {
      imported += affectedRows(await db.insert(downloadClicks).ignore().values(values.slice(i, i + 500)));
    }
    console.log(`Imported ${imported} new clicks (${values.length - imported} were already imported)`);
  }
  await source?.end();
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
