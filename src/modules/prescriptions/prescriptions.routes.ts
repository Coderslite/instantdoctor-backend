import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { pharmacyOptions } from './prescription-pharmacies.js';
import * as schemas from './prescriptions.schemas.js';
import * as service from './prescriptions.service.js';

/** The patient's e-prescriptions. Doctors issue them under /appointments/:id/prescriptions. */
export const prescriptionsRouter = Router();
prescriptionsRouter.use(authenticate);

prescriptionsRouter.get('/', async (req, res) => {
  const query = parse(schemas.listQuery, req.query);
  res.json({ items: await service.listForPatient(currentUser(req).userId, query), ...query });
});

prescriptionsRouter.get('/:id', async (req, res) => {
  res.json(await service.getForPatient(currentUser(req).userId, req.params.id));
});

/** Nearby pharmacies that stock the prescribed medicines, with prices and HMO cover. */
prescriptionsRouter.get('/:id/pharmacies', async (req, res) => {
  const query = parse(schemas.pharmacyOptionsQuery, req.query);
  res.json(await pharmacyOptions(currentUser(req).userId, req.params.id, query));
});

prescriptionsRouter.post('/:id/seen', async (req, res) => {
  await service.markSeen(currentUser(req).userId, req.params.id);
  res.status(204).end();
});
