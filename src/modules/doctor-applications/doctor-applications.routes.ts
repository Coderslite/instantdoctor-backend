import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticateAdmin, currentAdmin, requireAdminRole } from '../../middleware/authenticate-admin.js';
import { singleFile } from '../files/upload-middleware.js';
import * as schemas from './doctor-applications.schemas.js';
import * as service from './doctor-applications.service.js';

const limiter = (windowMinutes: number, limit: number) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
  });

/** Public: the "Become a provider" form on the website. */
export const doctorApplicationsRouter = Router();

/** One document per request (field "file"); the returned id goes in the application's `documents`. */
doctorApplicationsRouter.post('/documents', limiter(15, 40), singleFile, async (req, res) => {
  res.status(201).json(await service.uploadDocument(req.file!));
});

doctorApplicationsRouter.post('/', limiter(60, 5), async (req, res) => {
  res.status(201).json(await service.submit(parse(schemas.submitApplicationSchema, req.body)));
});

/** Admin review queue. */
export const adminDoctorApplicationsRouter = Router();
adminDoctorApplicationsRouter.use(authenticateAdmin);

adminDoctorApplicationsRouter.get('/', async (req, res) => {
  res.json(await service.list(parse(schemas.listApplicationsQuery, req.query)));
});

adminDoctorApplicationsRouter.get('/:id', async (req, res) => {
  res.json(await service.get(String(req.params.id)));
});

adminDoctorApplicationsRouter.post('/:id/approve', requireAdminRole('admin'), async (req, res) => {
  const { note } = parse(schemas.approveApplicationSchema, req.body ?? {});
  res.json(await service.approve(String(req.params.id), currentAdmin(req).adminId, note));
});

adminDoctorApplicationsRouter.post('/:id/reject', requireAdminRole('admin'), async (req, res) => {
  const { reason } = parse(schemas.rejectApplicationSchema, req.body);
  res.json(await service.reject(String(req.params.id), currentAdmin(req).adminId, reason));
});
