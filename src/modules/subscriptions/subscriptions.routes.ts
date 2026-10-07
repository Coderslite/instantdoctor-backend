import { Router } from 'express';
import { authenticate, currentUser, requireRole } from '../../middleware/authenticate.js';
import * as service from './subscriptions.service.js';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(authenticate, requireRole('user'));
subscriptionsRouter.get('/family', async (req, res) => res.json(await service.getFamilySubscription(currentUser(req).userId)));
subscriptionsRouter.post('/family/trial', async (req, res) => res.status(201).json(await service.startFamilyTrial(currentUser(req).userId)));
