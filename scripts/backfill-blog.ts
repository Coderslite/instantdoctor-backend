/**
 * Fills the blog fields that posts imported from Firestore lack: excerpt and
 * reading time. Idempotent; only rows without an excerpt are touched.
 *   npm run blog:backfill          (DB_TARGET=live npm run blog:backfill for production)
 */
import { eq, isNull, sql } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { healthTips } from '../src/db/schema/index.js';
import { excerptFrom, readingMinutes } from '../src/modules/blog/blog.content.js';

const rows = await db
  .select({ id: healthTips.id, description: healthTips.description })
  .from(healthTips)
  .where(isNull(healthTips.excerpt));
for (const row of rows) {
  await db
    .update(healthTips)
    // Keep updated_at: this is not an editorial change, so sitemap lastmod must not move.
    .set({
      excerpt: excerptFrom(row.description) || null,
      readingMinutes: readingMinutes(row.description),
      updatedAt: sql`${healthTips.updatedAt}`,
    })
    .where(eq(healthTips.id, row.id));
}
console.log(`Backfilled ${rows.length} post(s)`);
await closeDatabase();
