import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { profileQuerySchema } from '../family/family.schemas.js';
import { resolveProfileId } from '../family/family.service.js';
import * as schemas from './care-plans.schemas.js';
import * as service from './care-plans.service.js';

export const carePlansRouter = Router();
carePlansRouter.use(authenticate);

carePlansRouter.get('/', async (req, res) => {
  const { profileId } = parse(profileQuerySchema, req.query);
  const userId = currentUser(req).userId;
  res.json({ items: await service.listCarePlans(userId, await resolveProfileId(userId, profileId)) });
});

carePlansRouter.post('/', async (req, res) => {
  const input = parse(schemas.carePlanSchema, req.body);
  res.status(201).json(await service.createCarePlan(currentUser(req).userId, input));
});

carePlansRouter.get('/:id', async (req, res) => {
  res.json(await service.getCarePlan(currentUser(req).userId, req.params.id));
});

carePlansRouter.patch('/:id', async (req, res) => {
  const input = parse(schemas.updateCarePlanSchema, req.body);
  res.json(await service.updateCarePlan(currentUser(req).userId, req.params.id, input));
});

carePlansRouter.post('/:id/readings', async (req, res) => {
  const input = parse(schemas.vitalReadingSchema, req.body);
  res.status(201).json(await service.addVitalReading(currentUser(req).userId, req.params.id, input));
});
