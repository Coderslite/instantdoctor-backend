/**
 * Replaces every blog post with the starter articles in scripts/blog-seed/posts.ts.
 * Categories are kept (matched by slug); a "Instant Doctor Editorial Team" author is created if missing.
 *
 *   npm run blog:reseed              dry run: shows the target database and what would change
 *   npm run blog:reseed -- --yes     deletes ALL posts and creates the starter articles
 *   DB_TARGET=live npm run blog:reseed -- --yes   same, against production (irreversible)
 */
import { closeDatabase, databaseLabel, db } from '../src/db/client.js';
import { blogAuthors, healthTips } from '../src/db/schema/index.js';
import * as service from '../src/modules/blog/blog.service.js';
import { posts } from './blog-seed/posts.js';

const AUTHOR = {
  name: 'Instant Doctor Editorial Team',
  slug: 'instant-doctor-editorial-team',
  jobTitle: 'Health Content Team',
  bio: 'The Instant Doctor editorial team writes practical, evidence-based health guides to help you look after yourself and your family, and know when to talk to a doctor.',
  image: 'https://picsum.photos/seed/id-editorial-team/400/400',
  links: ['https://instantdoctor.co'],
};

const confirmed = process.argv.includes('--yes');
const DAY = 24 * 60 * 60 * 1000;

try {
  console.log(`Database: ${databaseLabel}`);
  const existing = await db.select({ id: healthTips.id, title: healthTips.title }).from(healthTips);
  const categories = await service.adminListCategories();
  const categoryId = new Map(categories.map((c) => [c.slug, c.id]));
  const missing = [...new Set(posts.map((p) => p.categorySlug))].filter((s) => !categoryId.has(s));
  if (missing.length) throw new Error(`Missing categories: ${missing.join(', ')} — create them first.`);

  console.log(`\nWill DELETE ${existing.length} post(s):`);
  existing.forEach((p) => console.log(`  - ${p.title}`));
  console.log(`\nWill CREATE ${posts.length} post(s):`);
  posts.forEach((p) => console.log(`  + ${p.title}  [${p.categorySlug}]${p.featured ? ' ★ featured' : ''}`));

  if (!confirmed) {
    console.log('\nDry run only. Re-run with --yes to apply.');
  } else {
    for (const p of existing) await service.deletePost(p.id);

    const authors = await db.select({ id: blogAuthors.id, slug: blogAuthors.slug }).from(blogAuthors);
    const authorId = authors.find((a) => a.slug === AUTHOR.slug)?.id ?? (await service.createAuthor(AUTHOR))!.id;

    const now = Date.now();
    for (const p of posts) {
      await service.createPost({
        title: p.title,
        slug: p.slug,
        excerpt: p.excerpt,
        description: p.body.trim(),
        image: p.image,
        imageAlt: p.imageAlt,
        categoryId: categoryId.get(p.categorySlug)!,
        authorId,
        reviewerId: null,
        tags: p.tags,
        featured: p.featured ?? false,
        status: 'published',
        publishedAt: new Date(now - p.daysAgo * DAY),
        metaTitle: p.metaTitle ?? null,
        metaDescription: p.metaDescription ?? null,
        focusKeyword: p.focusKeyword ?? null,
        canonicalUrl: null,
        noindex: false,
      });
    }
    console.log(`\nDone: deleted ${existing.length}, created ${posts.length}.`);
  }
} finally {
  await closeDatabase();
}
