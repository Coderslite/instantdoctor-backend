import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { renderCareSummaryPage } from './care-summary.page.js';
import * as summary from './care-summary.service.js';
import * as schemas from './family.schemas.js';
import { resolveProfileId } from './family.service.js';

/** Owner-side: preview the summary and manage share links. */
export const careSummaryRouter = Router();
careSummaryRouter.use(authenticate);

careSummaryRouter.get('/', async (req, res) => {
  const { profileId } = parse(schemas.profileQuerySchema, req.query);
  const owner = currentUser(req).userId;
  res.json(await summary.buildCareSummary(owner, await resolveProfileId(owner, profileId)));
});

careSummaryRouter.get('/shares', async (req, res) => {
  const { profileId } = parse(schemas.profileQuerySchema, req.query);
  const owner = currentUser(req).userId;
  res.json({ items: await summary.listActiveShares(owner, await resolveProfileId(owner, profileId)) });
});

careSummaryRouter.post('/shares', async (req, res) => {
  const input = parse(schemas.createShareSchema, req.body);
  res.status(201).json(await summary.createShare(currentUser(req).userId, input));
});

careSummaryRouter.delete('/shares/:id', async (req, res) => {
  await summary.revokeShare(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

/** Public, read-only view for a clinician holding a share link. */
export const publicCareSummaryRouter = Router();

publicCareSummaryRouter.get('/:token', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  const data = await summary.viewSharedSummary(req.params.token);
  if (req.accepts(['html', 'json']) === 'html') {
    res.type('html').send(renderCareSummaryPage(data));
  } else {
    res.json(data);
  }
});
