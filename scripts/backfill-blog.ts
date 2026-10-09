/**
 * Fills blog fields that imported rows lack: URL slugs for categories and
 * posts (rows imported after migration 0007 ran have none, which breaks their
 * links), plus post excerpts and reading time. Idempotent; only rows missing
 * a value are touched.
 *   npm run blog:backfill          (DB_TARGET=live npm run blog:backfill for production)
 */
import { eq, isNull, sql } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { healthTipCategories, healthTips } from '../src/db/schema/index.js';
import { excerptFrom, readingMinutes, slugify } from '../src/modules/blog/blog.content.js';

/** A slug from `source`, with a numeric suffix when another row already uses it. */
function uniqueSlug(source: string, id: string, taken: Set<string>) {
  const base = slugify(source) || id.toLowerCase().slice(0, 8);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

const categories = await db
  .select({
    id: healthTipCategories.id,
    name: healthTipCategories.name,
    slug: healthTipCategories.slug,
  })
  .from(healthTipCategories);
const takenCategorySlugs = new Set(categories.flatMap((c) => (c.slug ? [c.slug] : [])));
let categorySlugs = 0;
for (const category of categories.filter((c) => !c.slug)) {
  const slug = uniqueSlug(category.name, category.id, takenCategorySlugs);
  await db.update(healthTipCategories).set({ slug }).where(eq(healthTipCategories.id, category.id));
  console.log(`category  ${category.name} → ${slug}`);
  categorySlugs++;
}

const posts = await db
  .select({ id: healthTips.id, title: healthTips.title, slug: healthTips.slug })
  .from(healthTips);
const takenPostSlugs = new Set(posts.flatMap((p) => (p.slug ? [p.slug] : [])));
let postSlugs = 0;
for (const post of posts.filter((p) => !p.slug)) {
  const slug = uniqueSlug(post.title, post.id, takenPostSlugs);
  // Keep updated_at: this is not an editorial change, so sitemap lastmod must not move.
  await db
    .update(healthTips)
    .set({ slug, updatedAt: sql`${healthTips.updatedAt}` })
    .where(eq(healthTips.id, post.id));
  console.log(`post      ${post.title} → ${slug}`);
  postSlugs++;
}

const rows = await db
  .select({ id: healthTips.id, description: healthTips.description })
  .from(healthTips)
  .where(isNull(healthTips.excerpt));
for (const row of rows) {
  await db
    .update(healthTips)
    .set({
      excerpt: excerptFrom(row.description) || null,
      readingMinutes: readingMinutes(row.description),
      updatedAt: sql`${healthTips.updatedAt}`,
    })
    .where(eq(healthTips.id, row.id));
}
console.log(
  `Backfilled ${categorySlugs} category slug(s), ${postSlugs} post slug(s), ${rows.length} excerpt(s)`,
);
await closeDatabase();
