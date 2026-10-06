import { and, count, desc, eq, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderItems, orders, pharmacies, productCategories, products, users } from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { signPharmacyAccessToken } from '../../lib/tokens.js';
import { closeAllPortalSessions, closePortalSession, openPortalSession, rotatePortalSession } from '../auth/portal-sessions.js';

type ListInput = { search?: string; status?: string; limit: number; offset: number };
const searchTerm = (value?: string) => value ? `%${value}%` : undefined;

const pharmacySession = (pharmacyId: string, refreshToken: string) => ({
  accessToken: signPharmacyAccessToken(pharmacyId),
  refreshToken,
  tokenType: 'Bearer' as const,
});

export async function login(email: string, password: string, userAgent?: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.email, email.toLowerCase())).limit(1);
  if (!pharmacy?.passwordHash || !(await verifyPassword(password, pharmacy.passwordHash))) throw unauthorized('Invalid email or password');
  if (pharmacy.status !== 'active') throw forbidden('This pharmacy account is not active');
  return { pharmacy: publicProfile(pharmacy), session: pharmacySession(pharmacy.id, await openPortalSession('pharmacy', pharmacy.id, userAgent)) };
}

export async function refreshSession(refreshToken: string, userAgent?: string) {
  const rotated = await rotatePortalSession('pharmacy', refreshToken, userAgent);
  const [pharmacy] = await db.select({ status: pharmacies.status }).from(pharmacies).where(eq(pharmacies.id, rotated.subjectId)).limit(1);
  if (pharmacy?.status !== 'active') {
    await closeAllPortalSessions('pharmacy', rotated.subjectId);
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  return { session: pharmacySession(rotated.subjectId, rotated.refreshToken) };
}

export const logout = (refreshToken: string) => closePortalSession('pharmacy', refreshToken);

const publicProfile = (pharmacy: typeof pharmacies.$inferSelect) => ({ id: pharmacy.id, name: pharmacy.name, email: pharmacy.email, phoneNumber: pharmacy.phoneNumber, address: pharmacy.address, latitude: pharmacy.latitude, longitude: pharmacy.longitude, deliveryFeePerKm: pharmacy.deliveryFeePerKm, discount: pharmacy.discount, image: pharmacy.image, balance: pharmacy.balance, status: pharmacy.status });

export async function profile(id: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, id)).limit(1);
  if (!pharmacy) throw notFound('Pharmacy');
  return publicProfile(pharmacy);
}

export async function dashboard(pharmacyId: string) {
  const [[productCount], [lowStock], [outOfStock], [activeOrders], [completedOrders], [sales], recentOrders] = await Promise.all([
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'))),
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'), sql`${products.stockRemaining} between 1 and 5`)),
    db.select({ value: count() }).from(products).where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted'), eq(products.stockRemaining, 0))),
    db.select({ value: count() }).from(orders).where(and(eq(orders.pharmacyId, pharmacyId), sql`${orders.status} in ('pending','processing','delivering')`)),
    db.select({ value: count() }).from(orders).where(and(eq(orders.pharmacyId, pharmacyId), eq(orders.status, 'completed'))),
    db.select({ revenue: sql<number>`coalesce(sum(case when ${orders.status} = 'completed' then ${orders.totalAmount} else 0 end), 0)`, earnings: sql<number>`coalesce(sum(case when ${orders.status} = 'completed' then ${orders.pharmacyEarning} else 0 end), 0)` }).from(orders).where(eq(orders.pharmacyId, pharmacyId)),
    db.select({ id: orders.id, trackingId: orders.trackingId, status: orders.status, totalAmount: orders.totalAmount, createdAt: orders.createdAt, customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})` }).from(orders).innerJoin(users, eq(users.id, orders.userId)).where(eq(orders.pharmacyId, pharmacyId)).orderBy(desc(orders.createdAt)).limit(6),
  ]);
  return { productCount: productCount?.value ?? 0, lowStock: lowStock?.value ?? 0, outOfStock: outOfStock?.value ?? 0, activeOrders: activeOrders?.value ?? 0, completedOrders: completedOrders?.value ?? 0, revenue: Number(sales?.revenue ?? 0), earnings: Number(sales?.earnings ?? 0), recentOrders };
}

export async function listProducts(pharmacyId: string, query: ListInput) {
  const term = searchTerm(query.search);
  const where = and(eq(products.pharmacyId, pharmacyId), query.status ? eq(products.status, query.status) : ne(products.status, 'deleted'), term ? or(like(products.name, term), like(products.description, term)) : undefined);
  const [items, [total]] = await Promise.all([
    db.select({ id: products.id, categoryId: products.categoryId, categoryName: productCategories.name, name: products.name, description: products.description, amount: products.amount, purchasePrice: products.purchasePrice, discount: products.discount, stockRemaining: products.stockRemaining, images: products.images, status: products.status, createdAt: products.createdAt, updatedAt: products.updatedAt }).from(products).leftJoin(productCategories, eq(productCategories.id, products.categoryId)).where(where).orderBy(desc(products.updatedAt)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(products).where(where),
  ]);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function createProduct(pharmacyId: string, input: Omit<typeof products.$inferInsert, 'id' | 'pharmacyId'>) {
  const id = newId();
  await db.insert(products).values({ ...input, id, pharmacyId });
  const [item] = await db.select().from(products).where(eq(products.id, id));
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

export async function adjustStock(pharmacyId: string, id: string, quantity: number) {
  const item = await ownProduct(pharmacyId, id);
  const stockRemaining = item.stockRemaining + quantity;
  if (stockRemaining < 0) throw badRequest('Stock cannot be reduced below zero');
  await db.update(products).set({ stockRemaining }).where(eq(products.id, id));
  return { id, stockRemaining };
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
  const [order] = await db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, id), eq(orders.pharmacyId, pharmacyId))).limit(1);
  if (!order) throw notFound('Order');
  await db.update(orders).set({ status }).where(eq(orders.id, id));
  return getOrder(pharmacyId, id);
}

export async function updateProfile(pharmacyId: string, input: Partial<typeof pharmacies.$inferInsert>) {
  await db.update(pharmacies).set(input).where(eq(pharmacies.id, pharmacyId));
  return profile(pharmacyId);
}

export async function changePassword(pharmacyId: string, currentPassword: string, newPassword: string, userAgent?: string) {
  const [pharmacy] = await db.select().from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
  if (!pharmacy?.passwordHash || !(await verifyPassword(currentPassword, pharmacy.passwordHash))) throw unauthorized('Current password is incorrect');
  await db.update(pharmacies).set({ passwordHash: await hashPassword(newPassword) }).where(eq(pharmacies.id, pharmacyId));
  await closeAllPortalSessions('pharmacy', pharmacyId);
  return { updated: true, session: pharmacySession(pharmacyId, await openPortalSession('pharmacy', pharmacyId, userAgent)) };
}

export const categories = () => db.select().from(productCategories).orderBy(productCategories.name);
