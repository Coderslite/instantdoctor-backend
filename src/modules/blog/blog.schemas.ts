import { z } from 'zod';
import { BLOG_POST_STATUSES } from '../../db/schema/index.js';
import { isoDateTime } from '../../lib/validation.js';

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? v : v || null));
const optionalId = z
  .string()
  .max(36)
  .nullish()
  .transform((v) => (v === undefined ? v : v || null));
const optionalUrl = z
  .union([z.url({ protocol: /^https?$/ }).max(1024), z.literal('')])
  .nullish()
  .transform((v) => (v === undefined ? v : v || null));

// ── Public ──────────────────────────────────────────────────────────────────

export const publicListQuery = z.object({
  category: z.string().max(160).optional(),
  tag: z.string().max(60).optional(),
  author: z.string().max(160).optional(),
  q: z.string().trim().max(100).optional(),
  featured: z.enum(['true', 'false']).optional(),
  exclude: z.string().max(255).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type PublicListQuery = z.infer<typeof publicListQuery>;

// ── Admin ───────────────────────────────────────────────────────────────────

export const ADMIN_POST_FILTERS = ['all', 'published', 'scheduled', 'draft'] as const;

export const adminPostsQuery = z.object({
  status: z.enum(ADMIN_POST_FILTERS).default('all'),
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().max(36).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminPostsQuery = z.infer<typeof adminPostsQuery>;

const postFields = z.object({
  title: z.string().trim().min(1).max(255),
  slug: slug.optional().or(z.literal('').transform(() => undefined)),
  excerpt: optionalText(500),
  description: z.string().min(1, 'The post body is empty').max(2_000_000),
  image: optionalUrl,
  imageAlt: optionalText(255),
  categoryId: optionalId,
  authorId: optionalId,
  reviewerId: optionalId,
  reviewedAt: isoDateTime().nullish(),
  tags: z.array(z.string().max(60)).max(20),
  featured: z.boolean(),
  status: z.enum(BLOG_POST_STATUSES),
  /** Publish date; a future date schedules the post. Defaults to now when publishing. */
  publishedAt: isoDateTime().nullish(),
  metaTitle: optionalText(160),
  metaDescription: optionalText(320),
  focusKeyword: optionalText(120),
  canonicalUrl: optionalUrl,
  noindex: z.boolean(),
});
export const postSchema = postFields.extend({
  tags: postFields.shape.tags.default([]),
  featured: postFields.shape.featured.default(false),
  status: postFields.shape.status.default('draft'),
  noindex: postFields.shape.noindex.default(false),
});
export type PostInput = z.infer<typeof postSchema>;
// Built from the default-free fields so omitted keys stay undefined and are left untouched.
export const updatePostSchema = postFields.partial();
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: slug
    .max(150)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  description: optionalText(5000),
  image: optionalUrl,
  metaTitle: optionalText(160),
  metaDescription: optionalText(320),
  sortOrder: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type CategoryInput = z.infer<typeof categorySchema>;
export const updateCategorySchema = categorySchema
  .extend({ sortOrder: z.coerce.number().int().min(0).max(10_000) })
  .partial();

export const authorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: slug
    .max(150)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  jobTitle: optionalText(160),
  bio: optionalText(5000),
  image: optionalUrl,
  links: z
    .array(z.url({ protocol: /^https?$/ }).max(512))
    .max(10)
    .default([]),
});
export type AuthorInput = z.infer<typeof authorSchema>;
export const updateAuthorSchema = authorSchema
  .extend({ links: authorSchema.shape.links.unwrap() })
  .partial();
