import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { listTipsQuery } from './health-tips.schemas.js';
import * as service from './health-tips.service.js';

export const healthTipsRouter = Router();
healthTipsRouter.use(authenticate);

healthTipsRouter.get('/categories', async (_req, res) => {
  res.json({ items: await service.listCategories() });
});

healthTipsRouter.get('/', async (req, res) => {
  const query = parse(listTipsQuery, req.query);
  res.json({ items: await service.listTips(query), limit: query.limit, offset: query.offset });
});

healthTipsRouter.get('/:id', async (req, res) => {
  res.json(await service.readTip(currentUser(req).userId, req.params.id));
});

healthTipsRouter.get('/:id/related', async (req, res) => {
  res.json({ items: await service.relatedTips(req.params.id) });
});

healthTipsRouter.post('/:id/like', async (req, res) => {
  res.json(await service.toggleLike(currentUser(req).userId, req.params.id));
});
