import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import * as schemas from './users.schemas.js';
import * as service from './users.service.js';

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get('/me', async (req, res) => {
  res.json(await service.getMe(currentUser(req).userId));
});

usersRouter.patch('/me', async (req, res) => {
  const input = parse(schemas.updateProfileSchema, req.body);
  res.json(await service.updateMe(currentUser(req).userId, input));
});

usersRouter.put('/me/fcm-token', async (req, res) => {
  const { token } = parse(schemas.fcmTokenSchema, req.body);
  await service.setFcmToken(currentUser(req).userId, token);
  res.status(204).end();
});

usersRouter.put('/me/presence', async (req, res) => {
  const { presence } = parse(schemas.presenceSchema, req.body);
  await service.setPresence(currentUser(req).userId, presence);
  res.status(204).end();
});

usersRouter.get('/me/saved-locations', async (req, res) => {
  res.json({ items: await service.listSavedLocations(currentUser(req).userId) });
});

usersRouter.post('/me/saved-locations', async (req, res) => {
  const input = parse(schemas.savedLocationSchema, req.body);
  res.status(201).json(await service.addSavedLocation(currentUser(req).userId, input));
});

usersRouter.delete('/me/saved-locations/:id', async (req, res) => {
  await service.deleteSavedLocation(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

usersRouter.get('/tags/:tag/availability', async (req, res) => {
  const { tag } = parse(schemas.tagSchema, { tag: req.params.tag });
  res.json({ available: await service.isTagAvailable(tag) });
});

usersRouter.post('/me/referral-program', async (req, res) => {
  const { tag } = parse(schemas.tagSchema, req.body);
  res.json(await service.applyForReferralProgram(currentUser(req).userId, tag));
});

usersRouter.get('/:id', async (req, res) => {
  res.json(await service.getUserSummary(currentUser(req).userId, req.params.id));
});
