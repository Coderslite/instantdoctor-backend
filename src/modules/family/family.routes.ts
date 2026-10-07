import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import * as schemas from './family.schemas.js';
import * as service from './family.service.js';

export const familyRouter = Router();
familyRouter.use(authenticate);

familyRouter.get('/', async (req, res) => {
  res.json({ items: await service.listProfiles(currentUser(req).userId) });
});

// Declared before '/:id' so "overview" isn't read as a profile id.
familyRouter.get('/overview', async (req, res) => {
  res.json(await service.familyOverview(currentUser(req).userId));
});

familyRouter.post('/', async (req, res) => {
  const input = parse(schemas.familyProfileSchema, req.body);
  res.status(201).json(await service.createProfile(currentUser(req).userId, input));
});

familyRouter.get('/:id', async (req, res) => {
  res.json(await service.getProfile(currentUser(req).userId, req.params.id));
});

familyRouter.patch('/:id', async (req, res) => {
  const input = parse(schemas.updateFamilyProfileSchema, req.body);
  res.json(await service.updateProfile(currentUser(req).userId, req.params.id, input));
});

familyRouter.delete('/:id', async (req, res) => {
  await service.deleteProfile(currentUser(req).userId, req.params.id);
  res.status(204).end();
});
