import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticateAdmin, currentAdmin, requireAdminRole } from '../../middleware/authenticate-admin.js';
import * as schemas from './pharmacy-applications.schemas.js';
import * as applications from './pharmacy-applications.service.js';

/** Public: the "Partner with us" form on the website. Mounted at /pharmacy-applications. */
export const pharmacyApplicationsRouter = Router();
pharmacyApplicationsRouter.post(
  '/',
  rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => isTest }),
  async (req, res) => res.status(201).json(await applications.submit(parse(schemas.applicationSchema, req.body))),
);

/** Admin review. Mounted at /admin/pharmacy-applications. */
export const adminPharmacyApplicationsRouter = Router();
adminPharmacyApplicationsRouter.use(authenticateAdmin);
const canManage = requireAdminRole('admin');

adminPharmacyApplicationsRouter.get('/', async (req, res) =>
  res.json(await applications.list(parse(schemas.applicationsQuery, req.query))),
);
adminPharmacyApplicationsRouter.get('/:id', async (req, res) => res.json(await applications.get(String(req.params.id))));
adminPharmacyApplicationsRouter.post('/:id/approve', canManage, async (req, res) =>
  res.json(
    await applications.approve(String(req.params.id), currentAdmin(req).adminId, parse(schemas.approveApplicationSchema, req.body)),
  ),
);
adminPharmacyApplicationsRouter.post('/:id/reject', canManage, async (req, res) =>
  res.json(
    await applications.reject(String(req.params.id), currentAdmin(req).adminId, parse(schemas.rejectApplicationSchema, req.body).reason),
  ),
);
