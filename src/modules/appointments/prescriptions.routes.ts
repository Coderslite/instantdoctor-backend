import { Router } from 'express';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { markPrescriptionSeen } from './clinical.service.js';

export const prescriptionsRouter = Router();
prescriptionsRouter.use(authenticate);

prescriptionsRouter.post('/:id/seen', async (req, res) => {
  await markPrescriptionSeen(currentUser(req).userId, req.params.id);
  res.status(204).end();
});
