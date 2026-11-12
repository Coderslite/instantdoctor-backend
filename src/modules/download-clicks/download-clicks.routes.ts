import express, { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticateAdmin } from '../../middleware/authenticate-admin.js';
import type { RequestInfo } from '../blog/blog.analytics.js';
import * as service from './download-clicks.service.js';

/** Public: the website reports app store badge clicks here. Mounted at /download-clicks. */
export const downloadClicksRouter = Router();
const clickLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

/**
 * Beacons arrive as text/plain JSON (navigator.sendBeacon can't send
 * application/json cross-origin without a preflight); JSON bodies work too.
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
const requestInfo = (req: Request): RequestInfo => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? '',
  origin: req.get('origin'),
  headers: req.headers,
});

downloadClicksRouter.post('/', clickLimiter, beaconBody, async (req, res) => {
  const beacon = service.clickBeacon.safeParse(beaconJson(req));
  // Always 200 for a beacon: the page can't act on an error, and bad input just isn't counted.
  if (!beacon.success) return void res.json({ counted: false });
  res.json(await service.recordClick(beacon.data, requestInfo(req)));
});

/** Mounted at /admin/download-clicks. Reports for the admin "App downloads" page. */
export const adminDownloadClicksRouter = Router();
adminDownloadClicksRouter.use(authenticateAdmin);
adminDownloadClicksRouter.get('/report', async (req, res) =>
  res.json(await service.report(parse(service.reportQuery, req.query))),
);
adminDownloadClicksRouter.get('/', async (req, res) =>
  res.json(await service.listClicks(parse(service.listQuery, req.query))),
);
