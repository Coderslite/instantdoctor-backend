import { Router } from 'express';
import { notFound } from '../../lib/errors.js';
import { page, paginationQuery } from '../../lib/pagination.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/authenticate.js';
import { certificateSchema, listDoctorsQuery } from './doctors.schemas.js';
import * as service from './doctors.service.js';

export const doctorsRouter = Router();
doctorsRouter.use(authenticate);

doctorsRouter.get('/', async (req, res) => {
  const { limit } = parse(listDoctorsQuery, req.query);
  res.json({ items: await service.listAvailableDoctors(limit) });
});

/** Auto-assignment for "any available doctor" bookings. */
doctorsRouter.put('/me/certificate', requireRole('doctor'), async (req, res) => {
  const { fileId } = parse(certificateSchema, req.body);
  res.json(await service.setOwnCertificate(currentUser(req).userId, fileId));
});

doctorsRouter.get('/least-busy', async (_req, res) => {
  const id = await service.findLeastBusyDoctor();
  if (!id) throw notFound('Available doctor');
  res.json(await service.getDoctor(id));
});

doctorsRouter.get('/:id', async (req, res) => {
  res.json(await service.getDoctor(req.params.id));
});

doctorsRouter.get('/:id/reviews', async (req, res) => {
  const pagination = parse(paginationQuery, req.query);
  res.json(page(await service.listDoctorReviews(req.params.id, pagination), pagination));
});
