import { and, count, desc, eq, gt, like, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { inventoryMovements, orderItems, orders, pharmacies, pharmacyStaff, portalSessions, productCategories, products, purchaseOrderItems, purchaseOrders, suppliers, users } from '../../db/schema/index.js';
import { hashPassword, sha256, verifyPassword } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { signPharmacyAccessToken, signPharmacyStaffAccessToken } from '../../lib/tokens.js';
import { closeAllPortalSessions, closePortalSession, openPortalSession, rotatePortalSession } from '../auth/portal-sessions.js';
import { resolveFileUrl } from '../files/files.service.js';

type ListInput = { search?: string; status?: string; categoryId?: string; stock?: 'in_stock' | 'low_stock' | 'out_of_stock'; limit: number; offset: number };
const searchTerm = (value?: string) => value ? `%${value}%` : undefined;

const pharmacySession = (pharmacyId: string, refreshToken: string) => ({
  accessToken: signPharmacyAccessToken(pharmacyId),
  refreshToken,
  tokenType: 'Bearer' as const,
});
const pharmacyStaffSession = (pharmacyId: string, staffId: string, sessionVersion: number, refreshToken: string) => ({
  accessToken: signPharmacyStaffAccessToken(pharmacyId, staffId, sessionVersion),
  refreshToken,
  tokenType: 'Bearer' as const,
});

const canUseWorkspace = (status?: string | null) => status === 'active' || status === 'onboarding';

export async function login(email: string, password: string, userAgent?: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.email, email.toLowerCase())).limit(1);
  if (pharmacy?.passwordHash && await verifyPassword(password, pharmacy.passwordHash)) {
    if (!canUseWorkspace(pharmacy.status)) throw forbidden('This pharmacy account is not active');
    return { pharmacy: { ...await publicProfile(pharmacy), accountRole: 'owner' as const }, session: pharmacySession(pharmacy.id, await openPortalSession('pharmacy', pharmacy.id, userAgent)) };
  }
  const [staff] = await db.select().from(pharmacyStaff).where(eq(pharmacyStaff.email, email.toLowerCase())).limit(1);
  if (!staff?.passwordHash || !(await verifyPassword(password, staff.passwordHash))) throw unauthorized('Invalid email or password');
  if (staff.status !== 'active') throw forbidden('This staff account is not active');
  const [parent] = await db.select({ status: pharmacies.status }).from(pharmacies).where(eq(pharmacies.id, staff.pharmacyId)).limit(1);
  if (!canUseWorkspace(parent?.status)) throw forbidden('This pharmacy account is not active');
  return {
    pharmacy: {
      ...await profile(staff.pharmacyId),
      balance: undefined,
      accountRole: staff.role,
      mustChangePassword: staff.mustChangePassword,
    },
    session: pharmacyStaffSession(staff.pharmacyId, staff.id, staff.sessionVersion, await openPortalSession('pharmacy_staff', staff.id, userAgent)),
  };
}

export async function refreshSession(refreshToken: string, userAgent?: string) {
  const [storedSession] = await db
    .select({ subjectType: portalSessions.subjectType })
    .from(portalSessions)
    .where(eq(portalSessions.tokenHash, sha256(refreshToken)))
    .limit(1);
  if (storedSession?.subjectType === 'pharmacy_staff') {
    const rotated = await rotatePortalSession('pharmacy_staff', refreshToken, userAgent);
    const [staff] = await db
      .select({ id: pharmacyStaff.id, pharmacyId: pharmacyStaff.pharmacyId, role: pharmacyStaff.role, status: pharmacyStaff.status, pharmacyStatus: pharmacies.status, sessionVersion: pharmacyStaff.sessionVersion })
      .from(pharmacyStaff)
      .innerJoin(pharmacies, eq(pharmacies.id, pharmacyStaff.pharmacyId))
      .where(eq(pharmacyStaff.id, rotated.subjectId))
      .limit(1);
    if (!staff || staff.status !== 'active' || !canUseWorkspace(staff.pharmacyStatus)) {
      await closeAllPortalSessions('pharmacy_staff', rotated.subjectId);
      throw unauthorized('Your session has ended. Please sign in again.');
    }
    return { session: pharmacyStaffSession(staff.pharmacyId, staff.id, staff.sessionVersion, rotated.refreshToken) };
  }
  if (storedSession?.subjectType !== 'pharmacy') throw unauthorized('Your session has ended. Please sign in again.');
  const rotated = await rotatePortalSession('pharmacy', refreshToken, userAgent);
  const [pharmacy] = await db.select({ status: pharmacies.status }).from(pharmacies).where(eq(pharmacies.id, rotated.subjectId)).limit(1);
  if (!canUseWorkspace(pharmacy?.status)) {
    await closeAllPortalSessions('pharmacy', rotated.subjectId);
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  return { session: pharmacySession(rotated.subjectId, rotated.refreshToken) };
}

export async function logout(refreshToken: string) {
  await closePortalSession('pharmacy', refreshToken);
  await closePortalSession('pharmacy_staff', refreshToken);
}

const publicProfile = async (pharmacy: typeof pharmacies.$inferSelect) => ({ id: pharmacy.id, name: pharmacy.name, email: pharmacy.email, phoneNumber: pharmacy.phoneNumber, address: pharmacy.address, latitude: pharmacy.latitude, longitude: pharmacy.longitude, deliveryFeePerKm: pharmacy.deliveryFeePerKm, discount: pharmacy.discount, image: await resolveFileUrl(pharmacy.image), balance: pharmacy.balance, status: pharmacy.status });

export async function profile(id: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, id)).limit(1);
  if (!pharmacy) throw notFound('Pharmacy');
  return publicProfile(pharmacy);
}

export async function dashboard(pharmacyId: string) {
  const [[productCount], [lowStock], [outOfStock], [activeOrders], [completedOrders], [sales], recentOrders] = await Promise.all([
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'))),
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'), gt(products.stockRemaining, 0), lte(products.stockRemaining, products.reorderLevel))),
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'), eq(products.stockRemaining, 0))),
    db.select({ value: count() }).from(orders).where(and(eq(orders.pharmacyId, pharmacyId), sql`${orders.status} in ('pending','processing','delivering')`)),
    db.select({ value: count() }).from(orders).where(and(eq(orders.pharmacyId, pharmacyId), eq(orders.status, 'completed'))),
    db.select({ revenue: sql<number>`coalesce(sum(case when ${orders.status} = 'completed' then ${orders.totalAmount} else 0 end), 0)`, earnings: sql<number>`coalesce(sum(case when ${orders.status} = 'completed' then ${orders.pharmacyEarning} else 0 end), 0)` }).from(orders).where(eq(orders.pharmacyId, pharmacyId)),
    db.select({ id: orders.id, trackingId: orders.trackingId, status: orders.status, totalAmount: orders.totalAmount, createdAt: orders.createdAt, customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})` }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(eq(orders.pharmacyId, pharmacyId)).orderBy(desc(orders.createdAt)).limit(6),
  ]);
  return { productCount: productCount?.value ?? 0, lowStock: lowStock?.value ?? 0, outOfStock: outOfStock?.value ?? 0, activeOrders: activeOrders?.value ?? 0, completedOrders: completedOrders?.value ?? 0, revenue: Number(sales?.revenue ?? 0), earnings: Number(sales?.earnings ?? 0), recentOrders };
}

export async function listProducts(pharmacyId: string, query: ListInput, includePurchasePrices = true) {
  const term = searchTerm(query.search);
  const stockWhere = query.stock === 'out_of_stock' ? eq(products.stockRemaining, 0) : query.stock === 'low_stock' ? and(gt(products.stockRemaining, 0), lte(products.stockRemaining, products.reorderLevel)) : query.stock === 'in_stock' ? gt(products.stockRemaining, products.reorderLevel) : undefined;
  const where = and(eq(products.pharmacyId, pharmacyId), query.status ? eq(products.status, query.status) : ne(products.status, 'deleted'), query.categoryId ? eq(products.categoryId, query.categoryId) : undefined, stockWhere, term ? or(like(products.name, term), like(products.description, term), like(products.sku, term)) : undefined);
  const [items, [total]] = await Promise.all([
    db.select({ id: products.id, categoryId: products.categoryId, categoryName: productCategories.name, name: products.name, sku: products.sku, manufacturer: products.manufacturer, batchNumber: products.batchNumber, expiryDate: products.expiryDate, description: products.description, amount: products.amount, purchasePrice: products.purchasePrice, discount: products.discount, stockRemaining: products.stockRemaining, reorderLevel: products.reorderLevel, images: products.images, status: products.status, createdAt: products.createdAt, updatedAt: products.updatedAt }).from(products).leftJoin(productCategories, eq(productCategories.id, products.categoryId)).where(where).orderBy(desc(products.updatedAt)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(products).where(where),
  ]);
  return {
    items: includePurchasePrices ? items : items.map(({ purchasePrice: _purchasePrice, ...item }) => item),
    total: total?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function createProduct(pharmacyId: string, input: Omit<typeof products.$inferInsert, 'id' | 'pharmacyId'>) {
  const id = newId();
  await db.insert(products).values({ ...input, id, pharmacyId });
  const [item] = await db.select().from(products).where(eq(products.id, id));
  if (!item) throw notFound('Product');
  return item;
}

async function ownProduct(pharmacyId: string, id: string) {
  const [item] = await db.select().from(products).where(and(eq(products.id, id), eq(products.pharmacyId, pharmacyId))).limit(1);
  if (!item) throw notFound('Product');
  return item;
}

export async function updateProduct(pharmacyId: string, id: string, input: Partial<typeof products.$inferInsert>) {
  await ownProduct(pharmacyId, id);
  await db.update(products).set(input).where(and(eq(products.id, id), eq(products.pharmacyId, pharmacyId)));
  return ownProduct(pharmacyId, id);
}

export async function adjustStock(pharmacyId: string, id: string, quantity: number, reason?: string) {
  const item = await ownProduct(pharmacyId, id);
  const stockRemaining = item.stockRemaining + quantity;
  if (stockRemaining < 0) throw badRequest('Stock cannot be reduced below zero');
  await db.transaction(async (tx) => {
    await tx.update(products).set({ stockRemaining }).where(eq(products.id, id));
    await tx.insert(inventoryMovements).values({ id: newId(), pharmacyId, productId: id, quantity, reason });
  });
  return { id, stockRemaining };
}

export async function listStockMovements(pharmacyId: string, productId: string) {
  await ownProduct(pharmacyId, productId);
  return db.select({ id: inventoryMovements.id, quantity: inventoryMovements.quantity, reason: inventoryMovements.reason, createdAt: inventoryMovements.createdAt }).from(inventoryMovements).where(and(eq(inventoryMovements.pharmacyId, pharmacyId), eq(inventoryMovements.productId, productId))).orderBy(desc(inventoryMovements.createdAt)).limit(20);
}

export async function importProducts(pharmacyId: string, items: Array<Record<string, unknown> & { id?: string }>) {
  let created = 0; let updated = 0;
  await db.transaction(async (tx) => {
    for (const item of items) {
      const { id, ...input } = item;
      if (id) {
        const [existing] = await tx.select({ id: products.id }).from(products).where(and(eq(products.id, id), eq(products.pharmacyId, pharmacyId))).limit(1);
        if (!existing) throw badRequest(`Product ${id} does not belong to this pharmacy`);
        await tx.update(products).set(input).where(eq(products.id, id)); updated += 1;
      } else {
        await tx.insert(products).values({ ...input, id: newId(), pharmacyId } as typeof products.$inferInsert); created += 1;
      }
    }
  });
  return { created, updated, total: items.length };
}

export async function listOrders(pharmacyId: string, query: ListInput) {
  const term = searchTerm(query.search);
  const where = and(eq(orders.pharmacyId, pharmacyId), query.status ? eq(orders.status, query.status as typeof orders.status.enumValues[number]) : undefined, term ? or(like(orders.trackingId, term), like(users.firstName, term), like(users.lastName, term)) : undefined);
  const [items, [total]] = await Promise.all([
    db.select({ id: orders.id, trackingId: orders.trackingId, status: orders.status, subtotal: orders.subtotal, deliveryFee: orders.deliveryFee, totalAmount: orders.totalAmount, pharmacyEarning: orders.pharmacyEarning, address: orders.address, createdAt: orders.createdAt, customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`, customerPhone: users.phoneNumber }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(where).orderBy(desc(orders.createdAt)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(where),
  ]);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function getOrder(pharmacyId: string, id: string) {
  const [order] = await db.select({ id: orders.id, trackingId: orders.trackingId, status: orders.status, subtotal: orders.subtotal, deliveryFee: orders.deliveryFee, totalAmount: orders.totalAmount, pharmacyEarning: orders.pharmacyEarning, address: orders.address, latitude: orders.latitude, longitude: orders.longitude, createdAt: orders.createdAt, customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`, customerEmail: users.email, customerPhone: users.phoneNumber }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(and(eq(orders.id, id), eq(orders.pharmacyId, pharmacyId))).limit(1);
  if (!order) throw notFound('Order');
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
  return { ...order, items };
}

export async function updateOrderStatus(pharmacyId: string, id: string, status: typeof orders.status.enumValues[number]) {
  const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(and(eq(orders.id, id), eq(orders.pharmacyId, pharmacyId))).limit(1);
  if (!order) throw notFound('Order');
  // A pharmacy can only advance an order one operational step at a time. This
  // preserves a trustworthy patient tracker and prevents payment-controlled or
  // completed orders being accidentally reopened.
  const allowed: Partial<Record<typeof orders.status.enumValues[number], readonly typeof orders.status.enumValues[number][]>> = {
    pending: ['processing', 'cancelled'],
    processing: ['delivering'],
    delivering: ['completed'],
  };
  if (!allowed[order.status]?.includes(status)) {
    throw badRequest(`Order cannot move from ${order.status} to ${status}`);
  }
  await db.update(orders).set({ status }).where(eq(orders.id, id));
  return getOrder(pharmacyId, id);
}

export async function updateProfile(pharmacyId: string, input: Partial<typeof pharmacies.$inferInsert>) {
  await db.update(pharmacies).set(input).where(eq(pharmacies.id, pharmacyId));
  return profile(pharmacyId);
}

export const listStaff = (pharmacyId: string) =>
  db
    .select({
      id: pharmacyStaff.id,
      name: pharmacyStaff.name,
      email: pharmacyStaff.email,
      phoneNumber: pharmacyStaff.phoneNumber,
      role: pharmacyStaff.role,
      status: pharmacyStaff.status,
      createdAt: pharmacyStaff.createdAt,
      updatedAt: pharmacyStaff.updatedAt,
    })
    .from(pharmacyStaff)
    .where(eq(pharmacyStaff.pharmacyId, pharmacyId))
    .orderBy(desc(pharmacyStaff.createdAt));

export async function createStaff(
  pharmacyId: string,
  input: { name: string; email: string; password: string; phoneNumber?: string | null; role: 'manager' | 'pharmacist' | 'inventory_officer' | 'sales_assistant' },
) {
  const email = input.email.toLowerCase();
  const [existingPharmacy] = await db.select({ id: pharmacies.id }).from(pharmacies).where(eq(pharmacies.email, email)).limit(1);
  const [existingStaff] = await db.select({ id: pharmacyStaff.id }).from(pharmacyStaff).where(eq(pharmacyStaff.email, email)).limit(1);
  if (existingPharmacy || existingStaff) throw conflict('EMAIL_IN_USE', 'An account already uses this email address');
  const id = newId();
  await db.insert(pharmacyStaff).values({
    id,
    pharmacyId,
    name: input.name,
    email,
    passwordHash: await hashPassword(input.password),
    mustChangePassword: true,
    phoneNumber: input.phoneNumber,
    role: input.role,
  });
  const [staff] = await db
    .select({
      id: pharmacyStaff.id,
      name: pharmacyStaff.name,
      email: pharmacyStaff.email,
      phoneNumber: pharmacyStaff.phoneNumber,
      role: pharmacyStaff.role,
      status: pharmacyStaff.status,
      createdAt: pharmacyStaff.createdAt,
      updatedAt: pharmacyStaff.updatedAt,
    })
    .from(pharmacyStaff)
    .where(and(eq(pharmacyStaff.id, id), eq(pharmacyStaff.pharmacyId, pharmacyId)))
    .limit(1);
  return staff;
}

export async function updateStaff(
  pharmacyId: string,
  staffId: string,
  input: { role?: 'manager' | 'pharmacist' | 'inventory_officer' | 'sales_assistant'; status?: 'active' | 'inactive' },
) {
  const [staff] = await db.select({ id: pharmacyStaff.id }).from(pharmacyStaff)
    .where(and(eq(pharmacyStaff.id, staffId), eq(pharmacyStaff.pharmacyId, pharmacyId))).limit(1);
  if (!staff) throw notFound('Staff member');
  await db.update(pharmacyStaff).set(input)
    .where(and(eq(pharmacyStaff.id, staffId), eq(pharmacyStaff.pharmacyId, pharmacyId)));
  if (input.status) {
    await db.update(pharmacyStaff)
      .set({ sessionVersion: sql`${pharmacyStaff.sessionVersion} + 1` })
      .where(and(eq(pharmacyStaff.id, staffId), eq(pharmacyStaff.pharmacyId, pharmacyId)));
  }
  if (input.status === 'inactive') await closeAllPortalSessions('pharmacy_staff', staffId);
  const [updated] = await db.select({
    id: pharmacyStaff.id, name: pharmacyStaff.name, email: pharmacyStaff.email,
    phoneNumber: pharmacyStaff.phoneNumber, role: pharmacyStaff.role, status: pharmacyStaff.status,
    createdAt: pharmacyStaff.createdAt, updatedAt: pharmacyStaff.updatedAt,
  }).from(pharmacyStaff).where(eq(pharmacyStaff.id, staffId)).limit(1);
  return updated;
}

export async function changePassword(pharmacyId: string, currentPassword: string, newPassword: string, userAgent?: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
  if (!pharmacy?.passwordHash || !(await verifyPassword(currentPassword, pharmacy.passwordHash))) throw unauthorized('Current password is incorrect');
  await db.update(pharmacies).set({ passwordHash: await hashPassword(newPassword) }).where(eq(pharmacies.id, pharmacyId));
  await closeAllPortalSessions('pharmacy', pharmacyId);
  return { updated: true, session: pharmacySession(pharmacyId, await openPortalSession('pharmacy', pharmacyId, userAgent)) };
}

export async function changeStaffPassword(staffId: string, currentPassword: string, newPassword: string, userAgent?: string) {
  const [staff] = await db.select().from(pharmacyStaff).where(eq(pharmacyStaff.id, staffId)).limit(1);
  if (!staff?.passwordHash || !(await verifyPassword(currentPassword, staff.passwordHash))) {
    throw unauthorized('Current password is incorrect');
  }
  await db.update(pharmacyStaff).set({
    passwordHash: await hashPassword(newPassword),
    mustChangePassword: false,
    sessionVersion: staff.sessionVersion + 1,
  }).where(eq(pharmacyStaff.id, staffId));
  await closeAllPortalSessions('pharmacy_staff', staffId);
  return {
    updated: true,
    session: pharmacyStaffSession(staff.pharmacyId, staff.id, staff.sessionVersion + 1, await openPortalSession('pharmacy_staff', staff.id, userAgent)),
  };
}

export const categories = () => db.select().from(productCategories).orderBy(productCategories.name);

export const listSuppliers = (pharmacyId: string) => db.select().from(suppliers).where(eq(suppliers.pharmacyId, pharmacyId)).orderBy(desc(suppliers.updatedAt));

export async function createSupplier(pharmacyId: string, input: Omit<typeof suppliers.$inferInsert, 'id' | 'pharmacyId'>) {
  const id = newId();
  await db.insert(suppliers).values({ ...input, id, pharmacyId });
  const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, id));
  return supplier;
}

async function ownPurchaseOrder(pharmacyId: string, id: string) {
  const [order] = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.pharmacyId, pharmacyId))).limit(1);
  if (!order) throw notFound('Purchase order');
  return order;
}

export async function listPurchaseOrders(pharmacyId: string) {
  const rows = await db.select({ id: purchaseOrders.id, reference: purchaseOrders.reference, status: purchaseOrders.status, expectedDate: purchaseOrders.expectedDate, totalCost: purchaseOrders.totalCost, createdAt: purchaseOrders.createdAt, supplierName: suppliers.name }).from(purchaseOrders).leftJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId)).where(eq(purchaseOrders.pharmacyId, pharmacyId)).orderBy(desc(purchaseOrders.createdAt)).limit(100);
  return Promise.all(rows.map(async (order) => ({ ...order, items: await db.select({ id: purchaseOrderItems.id, productId: purchaseOrderItems.productId, productName: purchaseOrderItems.productName, quantity: purchaseOrderItems.quantity, receivedQuantity: purchaseOrderItems.receivedQuantity, unitCost: purchaseOrderItems.unitCost, batchNumber: purchaseOrderItems.batchNumber, expiryDate: purchaseOrderItems.expiryDate }).from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, order.id)) })));
}

export async function createPurchaseOrder(pharmacyId: string, input: { supplierId?: string | null; expectedDate?: string | null; notes?: string | null; items: Array<{ productId: string; quantity: number; unitCost: number; batchNumber?: string | null; expiryDate?: string | null }> }) {
  if (input.supplierId) {
    const [supplier] = await db.select({ id: suppliers.id }).from(suppliers).where(and(eq(suppliers.id, input.supplierId), eq(suppliers.pharmacyId, pharmacyId), eq(suppliers.status, 'active'))).limit(1);
    if (!supplier) throw badRequest('Select an active supplier from this pharmacy');
  }
  const productRows = await Promise.all(input.items.map((item) => ownProduct(pharmacyId, item.productId)));
  const id = newId();
  const totalCost = input.items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const reference = `PO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.slice(-5).toUpperCase()}`;
  await db.transaction(async (tx) => {
    await tx.insert(purchaseOrders).values({ id, pharmacyId, supplierId: input.supplierId ?? null, reference, expectedDate: input.expectedDate ?? null, notes: input.notes ?? null, totalCost });
    await tx.insert(purchaseOrderItems).values(input.items.map((item, index) => ({ id: newId(), purchaseOrderId: id, productId: item.productId, productName: productRows[index]?.name ?? "Product", quantity: item.quantity, unitCost: item.unitCost, batchNumber: item.batchNumber ?? null, expiryDate: item.expiryDate ?? null })));
  });
  return ownPurchaseOrder(pharmacyId, id);
}

export async function updatePurchaseOrderStatus(pharmacyId: string, id: string, status: 'ordered' | 'cancelled') {
  const order = await ownPurchaseOrder(pharmacyId, id);
  if (order.status !== 'draft') throw badRequest('Only draft purchase orders can be changed');
  await db.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, id));
  return ownPurchaseOrder(pharmacyId, id);
}

export async function receivePurchaseOrder(pharmacyId: string, id: string, received: Array<{ id: string; quantity: number }>) {
  const order = await ownPurchaseOrder(pharmacyId, id);
  if (order.status !== 'ordered' && order.status !== 'partial') throw badRequest('Only ordered purchase orders can be received');
  const items = await db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.purchaseOrderId, id));
  const receivedById = new Map(received.map((item) => [item.id, item.quantity]));
  if (receivedById.size !== received.length || received.some((item) => !items.some((line) => line.id === item.id))) throw badRequest('One or more receiving lines are invalid');
  await db.transaction(async (tx) => {
    for (const line of items) {
      const quantity = receivedById.get(line.id);
      if (!quantity) continue;
      const remaining = line.quantity - line.receivedQuantity;
      if (quantity > remaining) throw badRequest(`Cannot receive more than the remaining quantity for ${line.productName}`);
      if (!line.productId) throw badRequest(`${line.productName} is no longer linked to an inventory product`);
      const product = await ownProduct(pharmacyId, line.productId);
      await tx.update(products).set({ stockRemaining: product.stockRemaining + quantity, purchasePrice: line.unitCost, batchNumber: line.batchNumber, expiryDate: line.expiryDate }).where(eq(products.id, line.productId));
      await tx.update(purchaseOrderItems).set({ receivedQuantity: line.receivedQuantity + quantity }).where(eq(purchaseOrderItems.id, line.id));
      await tx.insert(inventoryMovements).values({ id: newId(), pharmacyId, productId: line.productId, quantity, reason: `Received on ${order.reference}` });
    }
    const after = items.map((line) => ({ ...line, receivedQuantity: line.receivedQuantity + (receivedById.get(line.id) ?? 0) }));
    const status = after.every((line) => line.receivedQuantity === line.quantity) ? 'received' : 'partial';
    await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, id));
  });
  return ownPurchaseOrder(pharmacyId, id);
}
