import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { refreshWebsiteBlog } from '../../integrations/website.js';
import { parse } from '../../lib/validation.js';
import {
  authenticateAdmin,
  currentAdmin,
  requireAdminRole,
} from '../../middleware/authenticate-admin.js';
import { uploadFile } from '../files/files.service.js';
import { singleFile } from '../files/upload-middleware.js';
import * as analytics from './blog.analytics.js';
import * as schemas from './blog.schemas.js';
import * as service from './blog.service.js';

/** Public, unauthenticated: read by the website and other public clients. */
export const blogRouter = Router();
const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});
const cache =
  (seconds: number) =>
  (_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader(
      'Cache-Control',
      `public, max-age=${seconds}, stale-while-revalidate=${seconds * 10}`,
    );
    next();
  };

blogRouter.get('/posts', cache(60), async (req, res) =>
  res.json(await service.listPublicPosts(parse(schemas.publicListQuery, req.query))),
);
blogRouter.get('/posts/:slug', cache(60), async (req, res) =>
  res.json(await service.getPublicPost(String(req.params.slug))),
);
/**
 * Beacons from the website arrive as text/plain JSON (navigator.sendBeacon can't send
 * application/json cross-origin without a preflight). An empty body still counts a view.
 */
const beaconBody = express.text({ type: () => true, limit: '4kb' });
const beaconJson = (req: Request): unknown => {
  if (typeof req.body !== 'string' || !req.body.trim()) return {};
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
};
const requestInfo = (req: Request): analytics.RequestInfo => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? '',
  origin: req.get('origin'),
  headers: req.headers,
});

blogRouter.post('/posts/:slug/view', viewLimiter, beaconBody, async (req, res) => {
  const beacon = analytics.viewBeacon.safeParse(beaconJson(req));
  res.json(
    await analytics.recordView(
      String(req.params.slug),
      beacon.success ? beacon.data : {},
      requestInfo(req),
    ),
  );
});
blogRouter.post('/views/engagement', viewLimiter, beaconBody, async (req, res) => {
  const beacon = analytics.engagementBeacon.safeParse(beaconJson(req));
  if (!beacon.success) return void res.status(204).end();
  res.json(await analytics.recordEngagement(beacon.data));
});
blogRouter.get('/categories', cache(300), async (_req, res) =>
  res.json({ items: await service.listPublicCategories() }),
);
blogRouter.get('/categories/:slug', cache(300), async (req, res) =>
  res.json(await service.getPublicCategory(String(req.params.slug))),
);
blogRouter.get('/authors/:slug', cache(300), async (req, res) =>
  res.json(await service.getPublicAuthor(String(req.params.slug))),
);
blogRouter.get('/tags', cache(300), async (_req, res) =>
  res.json({ items: await service.listPublicTags() }),
);
blogRouter.get('/sitemap', cache(300), async (_req, res) => res.json(await service.sitemap()));

/** Mounted at /admin/blog. Any admin can read; admins and marketers can write. */
export const adminBlogRouter = Router();
adminBlogRouter.use(authenticateAdmin);
// Any successful change to posts, categories or authors refreshes the live website's blog cache.
adminBlogRouter.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => res.statusCode < 400 && refreshWebsiteBlog());
  next();
});
const canWrite = requireAdminRole('admin', 'marketer');

adminBlogRouter.get('/analytics', async (req, res) =>
  res.json(await analytics.analytics(parse(analytics.analyticsQuery, req.query))),
);
adminBlogRouter.get('/posts', async (req, res) =>
  res.json(await service.adminListPosts(parse(schemas.adminPostsQuery, req.query))),
);
adminBlogRouter.get('/posts/:id', async (req, res) =>
  res.json(await service.adminGetPost(String(req.params.id))),
);
adminBlogRouter.post('/posts', canWrite, async (req, res) =>
  res.status(201).json(await service.createPost(parse(schemas.postSchema, req.body))),
);
adminBlogRouter.patch('/posts/:id', canWrite, async (req, res) =>
  res.json(
    await service.updatePost(String(req.params.id), parse(schemas.updatePostSchema, req.body)),
  ),
);
adminBlogRouter.delete('/posts/:id', canWrite, async (req, res) =>
  res.json(await service.deletePost(String(req.params.id))),
);

adminBlogRouter.get('/categories', async (_req, res) =>
  res.json({ items: await service.adminListCategories() }),
);
adminBlogRouter.post('/categories', canWrite, async (req, res) =>
  res.status(201).json(await service.createCategory(parse(schemas.categorySchema, req.body))),
);
adminBlogRouter.patch('/categories/:id', canWrite, async (req, res) =>
  res.json(
    await service.updateCategory(
      String(req.params.id),
      parse(schemas.updateCategorySchema, req.body),
    ),
  ),
);
adminBlogRouter.delete('/categories/:id', canWrite, async (req, res) =>
  res.json(await service.deleteCategory(String(req.params.id))),
);

adminBlogRouter.get('/authors', async (_req, res) =>
  res.json({ items: await service.adminListAuthors() }),
);
adminBlogRouter.post('/authors', canWrite, async (req, res) =>
  res.status(201).json(await service.createAuthor(parse(schemas.authorSchema, req.body))),
);
adminBlogRouter.patch('/authors/:id', canWrite, async (req, res) =>
  res.json(
    await service.updateAuthor(String(req.params.id), parse(schemas.updateAuthorSchema, req.body)),
  ),
);
adminBlogRouter.delete('/authors/:id', canWrite, async (req, res) =>
  res.json(await service.deleteAuthor(String(req.params.id))),
);

/** Images for featured images and the editor body. */
adminBlogRouter.post('/uploads', canWrite, singleFile, async (req, res) => {
  res
    .status(201)
    .json(
      await uploadFile({ kind: 'admin', id: currentAdmin(req).adminId }, 'blog_image', req.file!),
    );
});
