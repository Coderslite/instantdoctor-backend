import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { profileQuerySchema } from '../family/family.schemas.js';
import { resolveProfileId } from '../family/family.service.js';
import * as schemas from './medications.schemas.js';
import * as service from './medications.service.js';

export const medicationsRouter = Router();
medicationsRouter.use(authenticate);

medicationsRouter.get('/', async (req, res) => {
  const { profileId } = parse(profileQuerySchema, req.query);
  const userId = currentUser(req).userId;
  res.json({ items: await service.listMedications(userId, await resolveProfileId(userId, profileId)) });
});

medicationsRouter.post('/', async (req, res) => {
  const input = parse(schemas.medicationSchema, req.body);
  res.status(201).json(await service.createMedication(currentUser(req).userId, input));
});

medicationsRouter.get('/:id', async (req, res) => {
  res.json(await service.getMedication(currentUser(req).userId, req.params.id));
});

medicationsRouter.patch('/:id', async (req, res) => {
  const input = parse(schemas.updateMedicationSchema, req.body);
  res.json(await service.updateMedication(currentUser(req).userId, req.params.id, input));
});

medicationsRouter.delete('/:id', async (req, res) => {
  await service.deleteMedication(currentUser(req).userId, req.params.id);
  res.status(204).end();
});

medicationsRouter.put('/:id/doses', async (req, res) => {
  const input = parse(schemas.doseSchema, req.body);
  res.json(await service.recordDose(currentUser(req).userId, req.params.id, input));
});
