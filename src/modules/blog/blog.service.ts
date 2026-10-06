import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from '../../db/client.js';
import { blogAuthors, healthTipCategories, healthTips } from '../../db/schema/index.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import {
  excerptFrom,
  normalizeTags,
  readingMinutes,
  sanitizeBody,
  slugify,
  tagFromSlug,
  tagSlug,
} from './blog.content.js';
import type {
  AdminPostsQuery,
  AuthorInput,
  CategoryInput,
  PostInput,
  PublicListQuery,
  UpdatePostInput,
} from './blog.schemas.js';

const reviewers = alias(blogAuthors, 'reviewer');

/** Live on the website and in the app: published and not scheduled for later. */
export const isLive = () =>
  and(
    eq(healthTips.status, 'published'),
    isNotNull(healthTips.publishedAt),
    lte(healthTips.publishedAt, new Date()),
  );

const like_ = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const summaryColumns = {
  id: healthTips.id,
  slug: healthTips.slug,
  title: healthTips.title,
  excerpt: healthTips.excerpt,
  image: healthTips.image,
  imageAlt: healthTips.imageAlt,
  tags: healthTips.tags,
  featured: healthTips.featured,
  readingMinutes: healthTips.readingMinutes,
  views: healthTips.views,
  publishedAt: healthTips.publishedAt,
  updatedAt: healthTips.updatedAt,
  categoryId: healthTipCategories.id,
  categoryName: healthTipCategories.name,
  categorySlug: healthTipCategories.slug,
  authorId: blogAuthors.id,
  authorName: blogAuthors.name,
  authorSlug: blogAuthors.slug,
  authorImage: blogAuthors.image,
  authorJobTitle: blogAuthors.jobTitle,
};
type SummaryRow = {
  [K in keyof typeof summaryColumns]: (typeof summaryColumns)[K]['_']['data'] | null;
};

function shapeSummary(row: SummaryRow) {
  const {
    categoryId,
    categoryName,
    categorySlug,
    authorId,
    authorName,
    authorSlug,
    authorImage,
    authorJobTitle,
    ...post
  } = row;
  return {
    ...post,
    tags: post.tags ?? [],
    category: categoryId ? { id: categoryId, name: categoryName, slug: categorySlug } : null,
    author: authorId
      ? {
          id: authorId,
          name: authorName,
          slug: authorSlug,
          image: authorImage,
          jobTitle: authorJobTitle,
        }
      : null,
  };
}

const summaries = () =>
  db
    .select(summaryColumns)
    .from(healthTips)
    .leftJoin(healthTipCategories, eq(healthTipCategories.id, healthTips.categoryId))
    .leftJoin(blogAuthors, eq(blogAuthors.id, healthTips.authorId));

const tagCondition = (tag: string) =>
  or(
    sql`JSON_CONTAINS(${healthTips.tags}, JSON_QUOTE(${tagFromSlug(tag)}))`,
    sql`JSON_CONTAINS(${healthTips.tags}, JSON_QUOTE(${tag.toLowerCase()}))`,
  );

// ── Public blog ─────────────────────────────────────────────────────────────

export async function listPublicPosts(query: PublicListQuery) {
  const conditions: (SQL | undefined)[] = [isLive(), eq(healthTips.noindex, false)];
  if (query.category) conditions.push(eq(healthTipCategories.slug, query.category));
  if (query.author) conditions.push(eq(blogAuthors.slug, query.author));
  if (query.tag) conditions.push(tagCondition(query.tag));
  if (query.featured) conditions.push(eq(healthTips.featured, query.featured === 'true'));
  if (query.exclude) conditions.push(ne(healthTips.slug, query.exclude));
  if (query.q)
    conditions.push(
      or(
        like(healthTips.title, like_(query.q)),
        like(healthTips.excerpt, like_(query.q)),
        like(healthTips.focusKeyword, like_(query.q)),
      ),
    );
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    summaries()
      .where(where)
      .orderBy(desc(healthTips.publishedAt))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db
      .select({ n: count() })
      .from(healthTips)
      .leftJoin(healthTipCategories, eq(healthTipCategories.id, healthTips.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, healthTips.authorId))
      .where(where),
  ]);
  const n = total?.n ?? 0;
  return {
    items: rows.map(shapeSummary),
    total: n,
    page: query.page,
    limit: query.limit,
    pages: Math.max(1, Math.ceil(n / query.limit)),
  };
}

/**
 * Looks a live post up by slug, or by its legacy Firestore id so old
 * `/blog-details?id=` links can redirect to the canonical slug URL.
 */
export async function getPublicPost(slugOrId: string) {
  const [row] = await db
    .select({
      post: healthTips,
      category: healthTipCategories,
      author: blogAuthors,
      reviewer: reviewers,
    })
    .from(healthTips)
    .leftJoin(healthTipCategories, eq(healthTipCategories.id, healthTips.categoryId))
    .leftJoin(blogAuthors, eq(blogAuthors.id, healthTips.authorId))
    .leftJoin(reviewers, eq(reviewers.id, healthTips.reviewerId))
    .where(and(isLive(), or(eq(healthTips.slug, slugOrId), eq(healthTips.id, slugOrId))))
    .orderBy(sql`${healthTips.slug} = ${slugOrId} DESC`)
    .limit(1);
  if (!row) throw notFound('Post');
  const { post, category, author, reviewer } = row;

  const related = await relatedPosts(post.id, post.categoryId, post.tags ?? []);
  const [previous, next] = await Promise.all([
    summaries()
      .where(and(isLive(), sql`${healthTips.publishedAt} < ${post.publishedAt}`))
      .orderBy(desc(healthTips.publishedAt))
      .limit(1),
    summaries()
      .where(and(isLive(), gt(healthTips.publishedAt, post.publishedAt!)))
      .orderBy(asc(healthTips.publishedAt))
      .limit(1),
  ]);

  return {
    ...post,
    isSent: undefined,
    excerpt: post.excerpt ?? excerptFrom(post.description),
    tags: post.tags ?? [],
    category: category && {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
    },
    author: author && publicAuthor(author),
    reviewer: reviewer && publicAuthor(reviewer),
    related,
    previous: previous[0] ? shapeSummary(previous[0]) : null,
    next: next[0] ? shapeSummary(next[0]) : null,
  };
}

const publicAuthor = (a: typeof blogAuthors.$inferSelect) => ({
  id: a.id,
  name: a.name,
  slug: a.slug,
  jobTitle: a.jobTitle,
  bio: a.bio,
  image: a.image,
  links: a.links ?? [],
});

/** Same-category posts first, then posts sharing a tag, then the latest. */
async function relatedPosts(postId: string, categoryId: string | null, tags: string[], limit = 4) {
  const base = and(isLive(), ne(healthTips.id, postId), eq(healthTips.noindex, false));
  const score = sql`(CASE WHEN ${healthTips.categoryId} <=> ${categoryId} THEN 2 ELSE 0 END) + ${
    tags.length
      ? sql.join(
          tags.map(
            (t) =>
              sql`(CASE WHEN JSON_CONTAINS(${healthTips.tags}, JSON_QUOTE(${t})) THEN 1 ELSE 0 END)`,
          ),
          sql` + `,
        )
      : sql`0`
  }`;
  const rows = await summaries()
    .where(base)
    .orderBy(desc(score), desc(healthTips.publishedAt))
    .limit(limit);
  return rows.map(shapeSummary);
}

const livePostCount = sql<number>`count(${healthTips.id})`.mapWith(Number);
const lastPublished = sql<Date | null>`max(${healthTips.updatedAt})`.mapWith(healthTips.updatedAt);

export async function listPublicCategories() {
  return db
    .select({
      id: healthTipCategories.id,
      name: healthTipCategories.name,
      slug: healthTipCategories.slug,
      description: healthTipCategories.description,
      image: healthTipCategories.image,
      postCount: livePostCount,
    })
    .from(healthTipCategories)
    .leftJoin(
      healthTips,
      and(
        eq(healthTips.categoryId, healthTipCategories.id),
        isLive(),
        eq(healthTips.noindex, false),
      ),
    )
    .groupBy(healthTipCategories.id)
    .orderBy(asc(healthTipCategories.sortOrder), asc(healthTipCategories.name));
}

export async function getPublicCategory(slug: string) {
  const [category] = await db
    .select()
    .from(healthTipCategories)
    .where(eq(healthTipCategories.slug, slug))
    .limit(1);
  if (!category) throw notFound('Category');
  return category;
}

export async function getPublicAuthor(slug: string) {
  const [author] = await db.select().from(blogAuthors).where(eq(blogAuthors.slug, slug)).limit(1);
  if (!author) throw notFound('Author');
  const [posts] = await db
    .select({ n: count() })
    .from(healthTips)
    .where(and(isLive(), eq(healthTips.authorId, author.id)));
  return { ...publicAuthor(author), postCount: posts?.n ?? 0 };
}

export async function listPublicTags() {
  const rows = await db
    .select({ tags: healthTips.tags })
    .from(healthTips)
    .where(and(isLive(), eq(healthTips.noindex, false)));
  const counts = new Map<string, number>();
  for (const row of rows)
    for (const tag of row.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([name, postCount]) => ({ name, slug: tagSlug(name), postCount }))
    .sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name));
}

/** Everything the website needs for its XML sitemaps and RSS feed in one call. */
export async function sitemap() {
  const where = and(isLive(), eq(healthTips.noindex, false), isNotNull(healthTips.slug));
  const [posts, categories, authors] = await Promise.all([
    db
      .select({
        slug: healthTips.slug,
        title: healthTips.title,
        excerpt: healthTips.excerpt,
        image: healthTips.image,
        imageAlt: healthTips.imageAlt,
        tags: healthTips.tags,
        categoryName: healthTipCategories.name,
        authorName: blogAuthors.name,
        publishedAt: healthTips.publishedAt,
        updatedAt: healthTips.updatedAt,
      })
      .from(healthTips)
      .leftJoin(healthTipCategories, eq(healthTipCategories.id, healthTips.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, healthTips.authorId))
      .where(where)
      .orderBy(desc(healthTips.publishedAt)),
    db
      .select({
        slug: healthTipCategories.slug,
        postCount: livePostCount,
        updatedAt: lastPublished,
      })
      .from(healthTipCategories)
      .innerJoin(healthTips, and(eq(healthTips.categoryId, healthTipCategories.id), where))
      .groupBy(healthTipCategories.id),
    db
      .select({ slug: blogAuthors.slug, postCount: livePostCount, updatedAt: lastPublished })
      .from(blogAuthors)
      .innerJoin(healthTips, and(eq(healthTips.authorId, blogAuthors.id), where))
      .groupBy(blogAuthors.id),
  ]);
  return { posts, categories, authors };
}

// ── Admin: posts ────────────────────────────────────────────────────────────

const statusCondition = (status: AdminPostsQuery['status']) => {
  const now = new Date();
  switch (status) {
    case 'draft':
      return eq(healthTips.status, 'draft');
    case 'scheduled':
      return and(eq(healthTips.status, 'published'), gt(healthTips.publishedAt, now));
    case 'published':
      return isLive();
    default:
      return undefined;
  }
};

export async function adminListPosts(query: AdminPostsQuery) {
  const search = query.q
    ? or(like(healthTips.title, like_(query.q)), like(healthTips.slug, like_(query.q)))
    : undefined;
  const scope = and(
    search,
    query.categoryId ? eq(healthTips.categoryId, query.categoryId) : undefined,
  );
  const where = and(scope, statusCondition(query.status));
  const now = new Date();

  const [rows, [total], [counts]] = await Promise.all([
    db
      .select({
        ...summaryColumns,
        status: healthTips.status,
        noindex: healthTips.noindex,
        focusKeyword: healthTips.focusKeyword,
        createdAt: healthTips.createdAt,
      })
      .from(healthTips)
      .leftJoin(healthTipCategories, eq(healthTipCategories.id, healthTips.categoryId))
      .leftJoin(blogAuthors, eq(blogAuthors.id, healthTips.authorId))
      .where(where)
      .orderBy(
        desc(sql`COALESCE(${healthTips.publishedAt}, ${healthTips.createdAt})`),
        desc(healthTips.createdAt),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(healthTips).where(where),
    db
      .select({
        all: count(),
        draft: sql<number>`sum(${healthTips.status} = 'draft')`.mapWith(Number),
        scheduled:
          sql<number>`sum(${healthTips.status} = 'published' AND ${healthTips.publishedAt} > ${now})`.mapWith(
            Number,
          ),
        published:
          sql<number>`sum(${healthTips.status} = 'published' AND ${healthTips.publishedAt} <= ${now})`.mapWith(
            Number,
          ),
        views: sql<number>`coalesce(sum(${healthTips.views}), 0)`.mapWith(Number),
      })
      .from(healthTips)
      .where(scope),
  ]);
  return {
    items: rows.map(({ status, noindex, focusKeyword, createdAt, ...row }) => ({
      ...shapeSummary(row),
      status:
        status === 'published' && row.publishedAt && row.publishedAt > now ? 'scheduled' : status,
      noindex,
      focusKeyword,
      createdAt,
    })),
    total: total?.n ?? 0,
    limit: query.limit,
    offset: query.offset,
    counts: {
      all: counts?.all ?? 0,
      draft: counts?.draft ?? 0,
      scheduled: counts?.scheduled ?? 0,
      published: counts?.published ?? 0,
      views: counts?.views ?? 0,
    },
  };
}

export async function adminGetPost(id: string) {
  const [post] = await db.select().from(healthTips).where(eq(healthTips.id, id)).limit(1);
  if (!post) throw notFound('Post');
  return { ...post, tags: post.tags ?? [] };
}

async function slugTaken(
  table: typeof healthTips | typeof healthTipCategories | typeof blogAuthors,
  slug: string,
  exceptId?: string,
) {
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.slug, slug), exceptId ? ne(table.id, exceptId) : undefined))
    .limit(1);
  return Boolean(row);
}

/** An explicit slug must be free; a derived one gets a numeric suffix until it is. */
async function resolveSlug(
  table: typeof healthTips | typeof healthTipCategories | typeof blogAuthors,
  explicit: string | undefined,
  source: string,
  exceptId?: string,
) {
  if (explicit) {
    if (await slugTaken(table, explicit, exceptId))
      throw conflict('SLUG_TAKEN', `The URL slug "${explicit}" is already in use`);
    return explicit;
  }
  const base = slugify(source) || newId().slice(0, 8);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await slugTaken(table, candidate, exceptId))) return candidate;
  }
}

async function assertRefs(input: {
  categoryId?: string | null;
  authorId?: string | null;
  reviewerId?: string | null;
}) {
  if (input.categoryId) {
    const [c] = await db
      .select({ id: healthTipCategories.id })
      .from(healthTipCategories)
      .where(eq(healthTipCategories.id, input.categoryId));
    if (!c) throw badRequest('Unknown category');
  }
  const authorIds = [input.authorId, input.reviewerId].filter((v): v is string => Boolean(v));
  if (authorIds.length) {
    const found = await db
      .select({ id: blogAuthors.id })
      .from(blogAuthors)
      .where(inArray(blogAuthors.id, authorIds));
    if (found.length !== new Set(authorIds).size) throw badRequest('Unknown author or reviewer');
  }
}

function contentFields(input: UpdatePostInput, creating = false) {
  const fields: Partial<typeof healthTips.$inferInsert> = {};
  if (input.description !== undefined) {
    fields.description = sanitizeBody(input.description);
    if (!fields.description) throw badRequest('The post body is empty');
    fields.readingMinutes = readingMinutes(fields.description);
    // An excerpt left blank (or omitted on create) is generated so cards, RSS and the app always have a teaser.
    if (!input.excerpt && (creating || input.excerpt !== undefined))
      fields.excerpt = excerptFrom(fields.description) || null;
  }
  if (input.tags !== undefined) fields.tags = normalizeTags(input.tags);
  return fields;
}

export async function createPost(input: PostInput) {
  await assertRefs(input);
  const id = newId();
  const slug = await resolveSlug(healthTips, input.slug, input.title);
  try {
    await db.insert(healthTips).values({
      ...input,
      ...contentFields(input, true),
      id,
      slug,
      publishedAt: input.publishedAt ?? (input.status === 'published' ? new Date() : null),
    });
  } catch (err) {
    if (isDuplicateKeyError(err))
      throw conflict('SLUG_TAKEN', `The URL slug "${slug}" is already in use`);
    throw err;
  }
  return adminGetPost(id);
}

export async function updatePost(id: string, input: UpdatePostInput) {
  const current = await adminGetPost(id);
  await assertRefs(input);
  const requestedSlug = input.slug;
  const fields: Partial<typeof healthTips.$inferInsert> = { ...input, ...contentFields(input) };
  delete fields.slug;
  if (requestedSlug !== undefined && requestedSlug !== current.slug)
    fields.slug = await resolveSlug(healthTips, requestedSlug, input.title ?? current.title, id);
  if (!current.slug && !fields.slug)
    fields.slug = await resolveSlug(healthTips, undefined, input.title ?? current.title, id);
  const status = input.status ?? current.status;
  if (status === 'published' && !(input.publishedAt ?? current.publishedAt))
    fields.publishedAt = new Date();
  try {
    await db.update(healthTips).set(fields).where(eq(healthTips.id, id));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('SLUG_TAKEN', 'That URL slug is already in use');
    throw err;
  }
  return adminGetPost(id);
}

export async function deletePost(id: string) {
  const result = await db.delete(healthTips).where(eq(healthTips.id, id));
  if (affectedRows(result) === 0) throw notFound('Post');
  return { deleted: true };
}

// ── Admin: categories ───────────────────────────────────────────────────────

export async function adminListCategories() {
  const now = new Date();
  return db
    .select({
      id: healthTipCategories.id,
      name: healthTipCategories.name,
      slug: healthTipCategories.slug,
      description: healthTipCategories.description,
      image: healthTipCategories.image,
      metaTitle: healthTipCategories.metaTitle,
      metaDescription: healthTipCategories.metaDescription,
      sortOrder: healthTipCategories.sortOrder,
      postCount: sql<number>`count(${healthTips.id})`.mapWith(Number),
      liveCount:
        sql<number>`coalesce(sum(${healthTips.status} = 'published' AND ${healthTips.publishedAt} <= ${now}), 0)`.mapWith(
          Number,
        ),
    })
    .from(healthTipCategories)
    .leftJoin(healthTips, eq(healthTips.categoryId, healthTipCategories.id))
    .groupBy(healthTipCategories.id)
    .orderBy(asc(healthTipCategories.sortOrder), asc(healthTipCategories.name));
}

export async function createCategory(input: CategoryInput) {
  const id = newId();
  const slug = await resolveSlug(healthTipCategories, input.slug, input.name);
  await db.insert(healthTipCategories).values({ ...input, id, slug });
  return { id, ...input, slug };
}

export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const [current] = await db
    .select()
    .from(healthTipCategories)
    .where(eq(healthTipCategories.id, id));
  if (!current) throw notFound('Category');
  const fields = { ...input };
  if (input.slug !== undefined && input.slug !== current.slug)
    fields.slug = await resolveSlug(
      healthTipCategories,
      input.slug,
      input.name ?? current.name,
      id,
    );
  await db.update(healthTipCategories).set(fields).where(eq(healthTipCategories.id, id));
  return { ...current, ...fields };
}

/** Posts in a deleted category become uncategorised (FK is ON DELETE SET NULL). */
export async function deleteCategory(id: string) {
  const result = await db.delete(healthTipCategories).where(eq(healthTipCategories.id, id));
  if (affectedRows(result) === 0) throw notFound('Category');
  return { deleted: true };
}

// ── Admin: authors ──────────────────────────────────────────────────────────

export async function adminListAuthors() {
  return db
    .select({
      id: blogAuthors.id,
      name: blogAuthors.name,
      slug: blogAuthors.slug,
      jobTitle: blogAuthors.jobTitle,
      bio: blogAuthors.bio,
      image: blogAuthors.image,
      links: blogAuthors.links,
      postCount:
        sql<number>`(select count(*) from ${healthTips} where ${healthTips.authorId} = ${blogAuthors.id})`.mapWith(
          Number,
        ),
      reviewCount:
        sql<number>`(select count(*) from ${healthTips} where ${healthTips.reviewerId} = ${blogAuthors.id})`.mapWith(
          Number,
        ),
    })
    .from(blogAuthors)
    .orderBy(asc(blogAuthors.name));
}

export async function createAuthor(input: AuthorInput) {
  const id = newId();
  const slug = await resolveSlug(blogAuthors, input.slug, input.name);
  await db.insert(blogAuthors).values({ ...input, id, slug });
  const [author] = await db.select().from(blogAuthors).where(eq(blogAuthors.id, id));
  return author;
}

export async function updateAuthor(id: string, input: Partial<AuthorInput>) {
  const [current] = await db.select().from(blogAuthors).where(eq(blogAuthors.id, id));
  if (!current) throw notFound('Author');
  const fields = { ...input };
  if (input.slug !== undefined && input.slug !== current.slug)
    fields.slug = await resolveSlug(blogAuthors, input.slug, input.name ?? current.name, id);
  else delete fields.slug;
  await db.update(blogAuthors).set(fields).where(eq(blogAuthors.id, id));
  const [author] = await db.select().from(blogAuthors).where(eq(blogAuthors.id, id));
  return author;
}

export async function deleteAuthor(id: string) {
  const result = await db.delete(blogAuthors).where(eq(blogAuthors.id, id));
  if (affectedRows(result) === 0) throw notFound('Author');
  return { deleted: true };
}
