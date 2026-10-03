import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { getActiveVideoCallCredentials, getAppSettings, listCurrencies } from './settings.service.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', async (_req, res) => {
  res.json(await getAppSettings());
});

settingsRouter.get('/currencies', async (_req, res) => {
  res.json({ items: await listCurrencies() });
});

settingsRouter.get('/video-call/credentials', authenticate, async (_req, res) => {
  res.json(await getActiveVideoCallCredentials());
});
