import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import {
  authenticateAdmin,
  currentAdmin,
  requireAdminRole,
} from '../../middleware/authenticate-admin.js';
import { refreshSchema } from '../auth/auth.schemas.js';
import * as schemas from './admin.schemas.js';
import * as service from './admin.service.js';
import { purposeOf } from '../files/files.routes.js';
import { fileIdSchema, presignUploadSchema } from '../files/files.schemas.js';
import { attachFile, completeUpload, createUpload, uploadFile } from '../files/files.service.js';
import { singleFile } from '../files/upload-middleware.js';

export const adminRouter = Router();
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

adminRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(schemas.adminLoginSchema, req.body);
  res.json(await service.login(email, password, req.get('user-agent')));
});

adminRouter.post('/auth/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  res.json(await service.refreshSession(refreshToken, req.get('user-agent')));
});

adminRouter.post('/auth/logout', async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  await service.logout(refreshToken);
  res.status(204).end();
});

adminRouter.use(authenticateAdmin);
adminRouter.get('/dashboard', async (_req, res) => res.json(await service.dashboard()));
adminRouter.get('/commercial-fees', async (_req, res) => res.json({ fees: await service.getCommercialFees() }));
adminRouter.put('/commercial-fees', requireAdminRole('admin'), async (req, res) =>
  res.json(await service.updateCommercialFees(parse(schemas.commercialFeesSchema, req.body))),
);
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
adminRouter.patch('/doctors/:id', requireAdminRole('admin'), async (req, res) => {
  const { certificateFileId, ...input } = parse(schemas.updateDoctorSchema, req.body);
  const certificateUrl = certificateFileId
    ? await attachFile({ kind: 'admin', id: currentAdmin(req).adminId }, certificateFileId, [
        'doctor_document',
      ])
    : input.certificateUrl;
  res.json(await service.updateDoctor(String(req.params.id), { ...input, certificateUrl }));
});
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
  res.json(
    await service.updateProductCategory(
      String(req.params.id),
      parse(schemas.productCategorySchema, req.body),
    ),
  ),
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
/** Publishes an interpreted result uploaded directly to storage (see /admin/uploads/presign). */
adminRouter.post('/lab-results/:id/result', requireAdminRole('admin'), async (req, res) => {
  const admin = { kind: 'admin' as const, id: currentAdmin(req).adminId };
  const { fileId, ...fields } = req.body as Record<string, unknown>;
  const resultUrl = await attachFile(admin, parse(fileIdSchema, { fileId }).fileId, [
    'lab_result_report',
  ]);
  const input = parse(schemas.labResultStatusSchema, {
    ...fields,
    status: 'completed',
    reviewedAt: undefined,
  });
  res
    .status(201)
    .json(await service.updateLabResult(String(req.params.id), { ...input, resultUrl }));
});
adminRouter.post(
  '/lab-results/:id/upload',
  requireAdminRole('admin'),
  singleFile,
  async (req, res) => {
    const admin = { kind: 'admin' as const, id: currentAdmin(req).adminId };
    const file = await uploadFile(admin, 'lab_result_report', req.file!);
    const input = parse(schemas.labResultStatusSchema, {
      ...req.body,
      status: 'completed',
      reviewedAt: undefined,
    });
    const resultUrl = await attachFile(admin, file.id, ['lab_result_report']);
    res
      .status(201)
      .json(await service.updateLabResult(String(req.params.id), { ...input, resultUrl }));
  },
);
adminRouter.post('/uploads', singleFile, async (req, res) => {
  res
    .status(201)
    .json(
      await uploadFile({ kind: 'admin', id: currentAdmin(req).adminId }, purposeOf(req), req.file!),
    );
});
adminRouter.post('/uploads/presign', async (req, res) => {
  const { purpose, ...plan } = parse(presignUploadSchema, req.body);
  res
    .status(201)
    .json(await createUpload({ kind: 'admin', id: currentAdmin(req).adminId }, purpose, plan));
});
adminRouter.post('/uploads/:id/complete', async (req, res) => {
  res.json(
    await completeUpload({ kind: 'admin', id: currentAdmin(req).adminId }, String(req.params.id)),
  );
});
adminRouter.get('/payments', async (req, res) =>
  res.json(await service.listPayments(parse(schemas.adminListQuery, req.query))),
);
adminRouter.patch('/payments/:id/status', requireAdminRole('admin'), async (req, res) => {
  const { status, failureReason } = parse(schemas.paymentStatusSchema, req.body);
  res.json(await service.setPaymentStatus(String(req.params.id), status, failureReason));
});
