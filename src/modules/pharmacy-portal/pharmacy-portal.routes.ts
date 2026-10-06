import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import { authenticatePharmacy, currentPharmacy } from '../../middleware/authenticate-pharmacy.js';
import { refreshSchema } from '../auth/auth.schemas.js';
import * as schemas from './pharmacy-portal.schemas.js';
import * as service from './pharmacy-portal.service.js';
import { purposeOf } from '../files/files.routes.js';
import { presignUploadSchema } from '../files/files.schemas.js';
import { completeUpload, createUpload, uploadFile } from '../files/files.service.js';
import { singleFile } from '../files/upload-middleware.js';

export const pharmacyPortalRouter = Router();
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

pharmacyPortalRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const input = parse(schemas.loginSchema, req.body);
  res.json(await service.login(input.email, input.password, req.get('user-agent')));
});

pharmacyPortalRouter.post('/auth/refresh', refreshLimiter, async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  res.json(await service.refreshSession(refreshToken, req.get('user-agent')));
});

pharmacyPortalRouter.post('/auth/logout', async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  await service.logout(refreshToken);
  res.status(204).end();
});
pharmacyPortalRouter.use(authenticatePharmacy);

pharmacyPortalRouter.post('/uploads', singleFile, async (req, res) => {
  res
    .status(201)
    .json(
      await uploadFile(
        { kind: 'pharmacy', id: currentPharmacy(req).pharmacyId },
        purposeOf(req),
        req.file!,
      ),
    );
});
pharmacyPortalRouter.post('/uploads/presign', async (req, res) => {
  const { purpose, ...plan } = parse(presignUploadSchema, req.body);
  res
    .status(201)
    .json(
      await createUpload({ kind: 'pharmacy', id: currentPharmacy(req).pharmacyId }, purpose, plan),
    );
});
pharmacyPortalRouter.post('/uploads/:id/complete', async (req, res) => {
  res.json(
    await completeUpload(
      { kind: 'pharmacy', id: currentPharmacy(req).pharmacyId },
      String(req.params.id),
    ),
  );
});
pharmacyPortalRouter.get('/me', async (req, res) =>
  res.json(await service.profile(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.get('/dashboard', async (req, res) =>
  res.json(await service.dashboard(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.get('/categories', async (_req, res) =>
  res.json({ items: await service.categories() }),
);
pharmacyPortalRouter.get('/products', async (req, res) =>
  res.json(
    await service.listProducts(
      currentPharmacy(req).pharmacyId,
      parse(schemas.listSchema, req.query),
    ),
  ),
);
pharmacyPortalRouter.post('/products', async (req, res) =>
  res
    .status(201)
    .json(
      await service.createProduct(
        currentPharmacy(req).pharmacyId,
        parse(schemas.productSchema, req.body),
      ),
    ),
);
pharmacyPortalRouter.patch('/products/:id', async (req, res) =>
  res.json(
    await service.updateProduct(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      parse(schemas.updateProductSchema, req.body),
    ),
  ),
);
pharmacyPortalRouter.post('/products/:id/stock', async (req, res) => {
  const input = parse(schemas.stockSchema, req.body);
  res.json(
    await service.adjustStock(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      input.quantity,
    ),
  );
});
pharmacyPortalRouter.post('/products/import', async (req, res) => {
  const input = parse(schemas.importSchema, req.body);
  res.json(await service.importProducts(currentPharmacy(req).pharmacyId, input.products));
});
pharmacyPortalRouter.get('/orders', async (req, res) =>
  res.json(
    await service.listOrders(currentPharmacy(req).pharmacyId, parse(schemas.listSchema, req.query)),
  ),
);
pharmacyPortalRouter.get('/orders/:id', async (req, res) =>
  res.json(await service.getOrder(currentPharmacy(req).pharmacyId, String(req.params.id))),
);
pharmacyPortalRouter.patch('/orders/:id/status', async (req, res) => {
  const input = parse(schemas.orderStatusSchema, req.body);
  res.json(
    await service.updateOrderStatus(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      input.status,
    ),
  );
});
pharmacyPortalRouter.patch('/profile', async (req, res) =>
  res.json(
    await service.updateProfile(
      currentPharmacy(req).pharmacyId,
      parse(schemas.profileSchema, req.body),
    ),
  ),
);
pharmacyPortalRouter.patch('/password', async (req, res) => {
  const input = parse(schemas.passwordSchema, req.body);
  res.json(
    await service.changePassword(
      currentPharmacy(req).pharmacyId,
      input.currentPassword,
      input.newPassword,
      req.get('user-agent'),
    ),
  );
});
