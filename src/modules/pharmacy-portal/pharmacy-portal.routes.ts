import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { authenticatePharmacy, currentPharmacy, requirePharmacyRoles } from '../../middleware/authenticate-pharmacy.js';
import { refreshSchema } from '../auth/auth.schemas.js';
import * as schemas from './pharmacy-portal.schemas.js';
import * as service from './pharmacy-portal.service.js';
import * as store from './pharmacy-portal.marketplace.js';
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
const canManage = requirePharmacyRoles('manager');
const canManageInventory = requirePharmacyRoles('manager', 'inventory_officer');
const canWorkOrders = requirePharmacyRoles('manager', 'pharmacist', 'sales_assistant');
const canManageStaff = requirePharmacyRoles();
function redactSalesOrder<T extends {
  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  pharmacyEarning: number | null;
  items?: unknown;
}>(order: T) {
  return {
    ...order,
    subtotal: undefined,
    deliveryFee: undefined,
    totalAmount: undefined,
    pharmacyEarning: undefined,
    ...(Array.isArray(order.items) ? {
      items: order.items.map((item) =>
        typeof item === 'object' && item !== null ? { ...item, unitPrice: undefined } : item,
      ),
    } : {}),
  };
}

pharmacyPortalRouter.post('/uploads', canManageInventory, singleFile, async (req, res) => {
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
pharmacyPortalRouter.post('/uploads/presign', canManageInventory, async (req, res) => {
  const { purpose, ...plan } = parse(presignUploadSchema, req.body);
  res
    .status(201)
    .json(
      await createUpload({ kind: 'pharmacy', id: currentPharmacy(req).pharmacyId }, purpose, plan),
    );
});
pharmacyPortalRouter.post('/uploads/:id/complete', canManageInventory, async (req, res) => {
  res.json(
    await completeUpload(
      { kind: 'pharmacy', id: currentPharmacy(req).pharmacyId },
      String(req.params.id),
    ),
  );
});
pharmacyPortalRouter.get('/me', async (req, res) => {
  const auth = currentPharmacy(req);
  const pharmacy = await store.storeProfile(auth.pharmacyId);
  res.json({
    ...pharmacy,
    ...(auth.role !== 'owner' && auth.role !== 'manager' ? { balance: undefined } : {}),
    accountRole: auth.role,
    mustChangePassword: auth.mustChangePassword ?? false,
  });
});
pharmacyPortalRouter.get('/dashboard', canManage, async (req, res) =>
  res.json(await service.dashboard(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.get('/staff', canManageStaff, async (req, res) =>
  res.json({ items: await service.listStaff(currentPharmacy(req).pharmacyId) }),
);
pharmacyPortalRouter.post('/staff', canManageStaff, async (req, res) =>
  res
    .status(201)
    .json(
      await service.createStaff(
        currentPharmacy(req).pharmacyId,
        parse(schemas.staffSchema, req.body),
      ),
    ),
);
pharmacyPortalRouter.patch('/staff/:id', canManageStaff, async (req, res) =>
  res.json(await service.updateStaff(
    currentPharmacy(req).pharmacyId,
    String(req.params.id),
    parse(schemas.updateStaffSchema, req.body),
  )),
);
pharmacyPortalRouter.get('/categories', requirePharmacyRoles('manager', 'pharmacist', 'inventory_officer'), async (_req, res) =>
  res.json({ items: await service.categories() }),
);
pharmacyPortalRouter.get('/suppliers', canManageInventory, async (req, res) =>
  res.json({ items: await service.listSuppliers(currentPharmacy(req).pharmacyId) }),
);
pharmacyPortalRouter.post('/suppliers', canManageInventory, async (req, res) =>
  res
    .status(201)
    .json(
      await service.createSupplier(
        currentPharmacy(req).pharmacyId,
        parse(schemas.supplierSchema, req.body),
      ),
    ),
);
pharmacyPortalRouter.get('/purchase-orders', canManageInventory, async (req, res) => {
  const auth = currentPharmacy(req);
  const items = await service.listPurchaseOrders(auth.pharmacyId);
  if (auth.role === 'manager' || auth.role === 'owner') {
    res.json({ items });
    return;
  }
  res.json({ items: items.map(({ totalCost: _totalCost, items: lines, ...order }) => ({
    ...order,
    items: lines.map(({ unitCost: _unitCost, ...line }) => line),
  })) });
});
pharmacyPortalRouter.post('/purchase-orders', canManage, async (req, res) =>
  res
    .status(201)
    .json(
      await service.createPurchaseOrder(
        currentPharmacy(req).pharmacyId,
        parse(schemas.purchaseOrderSchema, req.body),
      ),
    ),
);
pharmacyPortalRouter.patch('/purchase-orders/:id/status', canManage, async (req, res) =>
  res.json(
    await service.updatePurchaseOrderStatus(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      parse(schemas.purchaseOrderStatusSchema, req.body).status,
    ),
  ),
);
pharmacyPortalRouter.post('/purchase-orders/:id/receive', canManageInventory, async (req, res) => {
  const auth = currentPharmacy(req);
  const order = await service.receivePurchaseOrder(
    auth.pharmacyId,
    String(req.params.id),
    parse(schemas.receivePurchaseOrderSchema, req.body).items,
  );
  if (auth.role === 'manager' || auth.role === 'owner') {
    res.json(order);
    return;
  }
  res.json({ ...order, totalCost: undefined });
});
pharmacyPortalRouter.get('/products', requirePharmacyRoles('manager', 'pharmacist', 'inventory_officer'), async (req, res) =>
  res.json(
    await service.listProducts(
      currentPharmacy(req).pharmacyId,
      parse(schemas.listSchema, req.query),
      currentPharmacy(req).role === 'owner' || currentPharmacy(req).role === 'manager',
    ),
  ),
);
pharmacyPortalRouter.post('/products', canManageInventory, async (req, res) => {
  const auth = currentPharmacy(req);
  const input = parse(schemas.productSchema, req.body);
  if (auth.role !== 'owner' && auth.role !== 'manager') delete input.purchasePrice;
  const product = await service.createProduct(auth.pharmacyId, input);
  if (auth.role !== 'owner' && auth.role !== 'manager') product.purchasePrice = null;
  res.status(201).json(product);
});
pharmacyPortalRouter.patch('/products/:id', canManageInventory, async (req, res) => {
  const auth = currentPharmacy(req);
  const input = parse(schemas.updateProductSchema, req.body);
  if (auth.role !== 'owner' && auth.role !== 'manager') delete input.purchasePrice;
  if (Object.keys(input).length === 0) throw badRequest('You do not have permission to change purchase cost');
  const product = await service.updateProduct(auth.pharmacyId, String(req.params.id), input);
  if (auth.role !== 'owner' && auth.role !== 'manager') product.purchasePrice = null;
  res.json(product);
});
pharmacyPortalRouter.post('/products/:id/stock', requirePharmacyRoles('manager', 'pharmacist', 'inventory_officer'), async (req, res) => {
  const input = parse(schemas.stockSchema, req.body);
  res.json(
    await service.adjustStock(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      input.quantity,
      input.reason,
    ),
  );
});
pharmacyPortalRouter.get('/products/:id/movements', requirePharmacyRoles('manager', 'pharmacist', 'inventory_officer'), async (req, res) =>
  res.json({
    items: await service.listStockMovements(currentPharmacy(req).pharmacyId, String(req.params.id)),
  }),
);
pharmacyPortalRouter.post('/products/import', canManageInventory, async (req, res) => {
  const auth = currentPharmacy(req);
  const input = parse(schemas.importSchema, req.body);
  const products = auth.role === 'owner' || auth.role === 'manager'
    ? input.products
    : input.products.map(({ purchasePrice: _purchasePrice, ...product }) => product);
  res.json(await service.importProducts(auth.pharmacyId, products));
});
pharmacyPortalRouter.get('/orders', canWorkOrders, async (req, res) => {
  const auth = currentPharmacy(req);
  const result = await service.listOrders(auth.pharmacyId, parse(schemas.listSchema, req.query));
  res.json(auth.role === 'sales_assistant'
    ? { ...result, items: result.items.map(redactSalesOrder) }
    : result);
});
pharmacyPortalRouter.get('/orders/:id', canWorkOrders, async (req, res) => {
  const auth = currentPharmacy(req);
  const order = await store.orderDetail(auth.pharmacyId, String(req.params.id));
  res.json(auth.role === 'sales_assistant' ? redactSalesOrder(order) : order);
});
/** Legacy one-step status change, mapped onto the fulfilment actions. */
pharmacyPortalRouter.patch('/orders/:id/status', canWorkOrders, async (req, res) => {
  const { status } = parse(schemas.orderStatusSchema, req.body);
  const pharmacyId = currentPharmacy(req).pharmacyId;
  const action: store.OrderAction | null =
    status === 'processing'
      ? { action: 'accept', etaMinutes: (await store.storeProfile(pharmacyId)).deliveryMinutes }
      : status === 'delivering'
        ? { action: 'dispatch', riderName: 'Pharmacy rider' }
        : status === 'completed'
          ? { action: 'deliver' }
          : status === 'cancelled'
            ? { action: 'cancel', reason: 'The pharmacy could not fulfil this order' }
            : null;
  if (!action) throw badRequest(`Orders can’t be moved to ${status}`);
  const order = await store.actOnOrder(pharmacyId, String(req.params.id), action);
  res.json(currentPharmacy(req).role === 'sales_assistant' ? redactSalesOrder(order) : order);
});
pharmacyPortalRouter.post('/orders/:id/actions', canWorkOrders, async (req, res) => {
  const auth = currentPharmacy(req);
  const order = await store.actOnOrder(
    auth.pharmacyId,
    String(req.params.id),
    parse(schemas.orderActionSchema, req.body),
  );
  res.json(auth.role === 'sales_assistant' ? redactSalesOrder(order) : order);
});
pharmacyPortalRouter.get('/orders-board', canWorkOrders, async (req, res) =>
  res.json(await store.boardCounts(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.get('/pulse', canWorkOrders, async (req, res) => {
  const pulse = await store.pulse(currentPharmacy(req).pharmacyId);
  const role = currentPharmacy(req).role;
  if (role !== 'manager' && role !== 'owner' && pulse.latestPending) {
    res.json({ ...pulse, latestPending: { ...pulse.latestPending, totalAmount: undefined } });
    return;
  }
  res.json(pulse);
});
pharmacyPortalRouter.patch('/availability', canManage, async (req, res) =>
  res.json(
    await store.setAvailability(
      currentPharmacy(req).pharmacyId,
      parse(schemas.availabilitySchema, req.body).acceptingOrders,
    ),
  ),
);
pharmacyPortalRouter.post('/go-live', canManage, async (req, res) =>
  res.json(await store.goLive(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.post('/go-offline', canManage, async (req, res) =>
  res.json(await store.goOffline(currentPharmacy(req).pharmacyId)),
);
pharmacyPortalRouter.get('/reviews', canManage, async (req, res) =>
  res.json(
    await store.listReviews(currentPharmacy(req).pharmacyId, parse(schemas.pageSchema, req.query)),
  ),
);
pharmacyPortalRouter.post('/reviews/:id/reply', canManage, async (req, res) =>
  res.json(
    await store.replyToReview(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      parse(schemas.reviewReplySchema, req.body).reply,
    ),
  ),
);
pharmacyPortalRouter.get('/issues', canManage, async (req, res) =>
  res.json(
    await store.listIssues(
      currentPharmacy(req).pharmacyId,
      parse(schemas.issueListSchema, req.query),
    ),
  ),
);
pharmacyPortalRouter.post('/issues/:id/respond', canManage, async (req, res) =>
  res.json(
    await store.respondToIssue(
      currentPharmacy(req).pharmacyId,
      String(req.params.id),
      parse(schemas.issueResponseSchema, req.body),
    ),
  ),
);
pharmacyPortalRouter.patch('/profile', canManage, async (req, res) => {
  const pharmacyId = currentPharmacy(req).pharmacyId;
  const { openingHours, coverImage, description, timeZone, deliveryMinutes, ...basic } = parse(
    schemas.profileSchema,
    req.body,
  );
  if (Object.keys(basic).length) await service.updateProfile(pharmacyId, basic);
  const storeFields = Object.fromEntries(
    Object.entries({ openingHours, coverImage, description, timeZone, deliveryMinutes }).filter(
      ([, v]) => v !== undefined,
    ),
  );
  res.json(await store.updateStore(pharmacyId, storeFields));
});
pharmacyPortalRouter.patch('/password', async (req, res) => {
  const input = parse(schemas.passwordSchema, req.body);
  const auth = currentPharmacy(req);
  res.json(auth.staffId
    ? await service.changeStaffPassword(auth.staffId, input.currentPassword, input.newPassword, req.get('user-agent'))
    : await service.changePassword(auth.pharmacyId, input.currentPassword, input.newPassword, req.get('user-agent')));
});
