import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { createLabResultSchema } from './lab-results.schemas.js';
import * as service from './lab-results.service.js';

export const labResultsRouter = Router();
labResultsRouter.use(authenticate);

labResultsRouter.get('/price', async (req, res) => {
  const quote = await service.quoteForUser(currentUser(req).userId);
  res.json({ amount: quote.amount, currency: quote.currency, amountUsd: quote.amountUsd });
});

labResultsRouter.post('/', idempotent('lab-results.create'), async (req, res) => {
  const { files } = parse(createLabResultSchema, req.body);
  res.status(201).json(await service.createLabResult(currentUser(req).userId, files));
});

labResultsRouter.get('/', async (req, res) => {
  res.json({ items: await service.listLabResults(currentUser(req).userId) });
});

labResultsRouter.post('/:id/opened', async (req, res) => {
  await service.markOpened(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

labResultsRouter.delete('/:id', async (req, res) => {
  await service.deleteLabResult(currentUser(req).userId, req.params.id);
  res.status(204).end();
});
