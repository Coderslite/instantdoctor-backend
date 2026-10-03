import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { listReferralsQuery } from './referrals.schemas.js';
import * as service from './referrals.service.js';

export const referralsRouter = Router();
referralsRouter.use(authenticate);

referralsRouter.get('/', async (req, res) => {
  const { month } = parse(listReferralsQuery, req.query);
  res.json({ items: await service.listReferrals(currentUser(req).userId, month ? new Date(`${month}-01T00:00:00Z`) : undefined) });
});

referralsRouter.get('/summary', async (req, res) => {
  res.json(await service.referralSummary(currentUser(req).userId));
});
