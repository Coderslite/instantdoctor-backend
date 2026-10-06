import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticateAdmin, requireAdminRole } from '../../middleware/authenticate-admin.js';
import * as schemas from './admin.schemas.js';
import * as service from './admin.service.js';
import { upload, contentMatchesType } from '../uploads/uploads.routes.js';
import { storeFile } from '../../integrations/storage.js';
import { badRequest } from '../../lib/errors.js';

export const adminRouter = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

adminRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(schemas.adminLoginSchema, req.body);
  res.json(await service.login(email, password));
});

adminRouter.use(authenticateAdmin);
adminRouter.get('/dashboard', async (_req, res) => res.json(await service.dashboard()));
adminRouter.get('/patients', async (req, res) =>
  res.json(await service.listUsers('user', parse(schemas.adminListQuery, req.query))),
);
adminRouter.get('/patients/:id', async (req, res) =>
  res.json(await service.getPatient(String(req.params.id))),
);
adminRouter.patch('/patients/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updatePatient(
      String(req.params.id),
      parse(schemas.updatePatientSchema, req.body),
    ),
  ),
);
adminRouter.post('/patients/:id/email', requireAdminRole('admin'), async (req, res) => {
  const { subject, message } = parse(schemas.patientEmailSchema, req.body);
  res.json(await service.emailPatient(String(req.params.id), subject, message));
});
adminRouter.post('/patients/:id/push', requireAdminRole('admin'), async (req, res) => {
  const { title, message } = parse(schemas.patientPushSchema, req.body);
  res.json(await service.pushPatient(String(req.params.id), title, message));
});
adminRouter.get('/doctors', async (req, res) =>
  res.json(await service.listDoctors(parse(schemas.adminListQuery, req.query))),
);
adminRouter.get('/doctors/:id', async (req, res) =>
  res.json(await service.getDoctor(String(req.params.id))),
);
adminRouter.patch('/doctors/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updateDoctor(String(req.params.id), parse(schemas.updateDoctorSchema, req.body)),
  ),
);
adminRouter.patch('/users/:id/status', requireAdminRole('admin'), async (req, res) => {
  const { status } = parse(schemas.userStatusSchema, req.body);
  res.json(await service.setUserStatus(String(req.params.id), status));
});
adminRouter.get('/appointments', async (req, res) =>
  res.json(await service.listAppointments(parse(schemas.adminListQuery, req.query))),
);
adminRouter.post('/appointments', requireAdminRole('admin'), async (req, res) =>
  res
    .status(201)
    .json(await service.createAppointment(parse(schemas.createAppointmentSchema, req.body))),
);
adminRouter.get('/appointments/:id', async (req, res) =>
  res.json(await service.getAppointment(String(req.params.id))),
);
adminRouter.patch('/appointments/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updateAppointment(
      String(req.params.id),
      parse(schemas.updateAppointmentSchema, req.body),
    ),
  ),
);
adminRouter.patch('/appointments/:id/status', requireAdminRole('admin'), async (req, res) => {
  const { status } = parse(schemas.appointmentStatusSchema, req.body);
  res.json(await service.setAppointmentStatus(String(req.params.id), status));
});
adminRouter.get('/appointment-packages', async (_req, res) =>
  res.json({ items: await service.listAppointmentPackages() }),
);
adminRouter.post('/appointment-packages', requireAdminRole('admin'), async (req, res) =>
  res
    .status(201)
    .json(
      await service.createAppointmentPackage(parse(schemas.appointmentPackageSchema, req.body)),
    ),
);
adminRouter.patch('/appointment-packages/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updateAppointmentPackage(
      String(req.params.id),
      parse(schemas.updateAppointmentPackageSchema, req.body),
    ),
  ),
);
adminRouter.get('/pharmacies', async (req, res) =>
  res.json(await service.listPharmacies(parse(schemas.adminListQuery, req.query))),
);
adminRouter.post('/pharmacies', requireAdminRole('admin'), async (req, res) =>
  res.status(201).json(await service.createPharmacy(parse(schemas.pharmacySchema, req.body))),
);
adminRouter.get('/pharmacies/:id', async (req, res) =>
  res.json(await service.getAdminPharmacy(String(req.params.id))),
);
adminRouter.patch('/pharmacies/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updatePharmacy(
      String(req.params.id),
      parse(schemas.updatePharmacySchema, req.body),
    ),
  ),
);
adminRouter.post('/products', requireAdminRole('admin'), async (req, res) =>
  res.status(201).json(await service.createProduct(parse(schemas.productSchema, req.body))),
);
adminRouter.patch('/products/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(
    await service.updateProduct(
      String(req.params.id),
      parse(schemas.updateProductSchema, req.body),
    ),
  ),
);
adminRouter.post('/pharmacies/:id/products/import', requireAdminRole('admin'), async (req, res) => {
  const { products } = parse(schemas.importProductsSchema, req.body);
  res.json(await service.importProducts(String(req.params.id), products));
});
adminRouter.get('/product-categories', async (_req, res) =>
  res.json({ items: await service.listProductCategories() }),
);
adminRouter.post('/product-categories', requireAdminRole('admin'), async (req, res) =>
  res
    .status(201)
    .json(await service.createProductCategory(parse(schemas.productCategorySchema, req.body))),
);
adminRouter.patch('/product-categories/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(await service.updateProductCategory(String(req.params.id), parse(schemas.productCategorySchema, req.body))),
);
adminRouter.delete('/product-categories/:id', requireAdminRole('admin'), async (req, res) =>
  res.json(await service.deleteProductCategory(String(req.params.id))),
);
adminRouter.get('/orders', async (req, res) =>
  res.json(await service.listOrders(parse(schemas.adminListQuery, req.query))),
);
adminRouter.patch('/orders/:id/status', requireAdminRole('admin'), async (req, res) => {
  const { status } = parse(schemas.orderStatusSchema, req.body);
  res.json(await service.setOrderStatus(String(req.params.id), status));
});
adminRouter.get('/lab-results', async (req, res) =>
  res.json(await service.listLabResults(parse(schemas.adminListQuery, req.query))),
);
adminRouter.get('/lab-results/:id', async (req, res) =>
  res.json(await service.getLabResult(String(req.params.id))),
);
adminRouter.patch('/lab-results/:id/status', requireAdminRole('admin'), async (req, res) => {
  res.json(
    await service.updateLabResult(
      String(req.params.id),
      parse(schemas.labResultStatusSchema, req.body),
    ),
  );
});
adminRouter.post(
  '/lab-results/:id/upload',
  requireAdminRole('admin'),
  upload.single('file'),
  async (req, res) => {
    if (!req.file) throw badRequest('A PDF or image result file is required');
    if (!contentMatchesType(req.file.buffer, req.file.mimetype))
      throw badRequest(`File content does not match its declared type (${req.file.mimetype})`);
    const stored = await storeFile('lab-results', req.file);
    const input = parse(schemas.labResultStatusSchema, {
      ...req.body,
      resultUrl: stored.url,
      status: 'completed',
      reviewedAt: undefined,
    });
    res.status(201).json(await service.updateLabResult(String(req.params.id), input));
  },
);
adminRouter.get('/payments', async (req, res) =>
  res.json(await service.listPayments(parse(schemas.adminListQuery, req.query))),
);
adminRouter.patch('/payments/:id/status', requireAdminRole('admin'), async (req, res) => {
  const { status, failureReason } = parse(schemas.paymentStatusSchema, req.body);
  res.json(await service.setPaymentStatus(String(req.params.id), status, failureReason));
});
