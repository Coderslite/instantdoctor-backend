import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import { orderCheckouts, orderItems, orders, pharmacies, productCategories, products } from '../../db/schema/index.js';
import { distanceKm, type LatLng } from '../../lib/geo.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';
import { orderSurcharge } from '../pricing/fees.js';
import type { cartSchema, checkoutSchema } from './pharmacy.schemas.js';

/** Pharmacy catalogue prices are in NGN. */
export const PHARMACY_CURRENCY = 'NGN';

type Pharmacy = typeof pharmacies.$inferSelect;

function serializePharmacy(p: Pharmacy, from?: LatLng) {
  const location = p.latitude !== null && p.longitude !== null ? { latitude: p.latitude, longitude: p.longitude } : null;
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    phoneNumber: p.phoneNumber,
    address: p.address,
    image: p.image,
    discount: p.discount,
    deliveryFeePerKm: p.deliveryFeePerKm,
    location,
    distanceKm: from && location ? Math.round(distanceKm(from, location) * 100) / 100 : null,
  };
}

export async function listPharmacies(query: { latitude?: number; longitude?: number; radiusKm: number }) {
  const rows = await db.select().from(pharmacies).where(ne(pharmacies.status, 'deleted'));
  if (query.latitude === undefined || query.longitude === undefined) return rows.map((p) => serializePharmacy(p));
  const origin = { latitude: query.latitude, longitude: query.longitude };
  return rows
    .map((p) => serializePharmacy(p, origin))
    .filter((p) => p.distanceKm !== null && p.distanceKm <= query.radiusKm)
    .sort((a, b) => a.distanceKm! - b.distanceKm!);
}

export async function getPharmacy(id: string) {
  const [row] = await db.select().from(pharmacies).where(and(eq(pharmacies.id, id), ne(pharmacies.status, 'deleted'))).limit(1);
  if (!row) throw notFound('Pharmacy');
  return serializePharmacy(row);
}

export const listPharmacyProducts = (pharmacyId: string) =>
  db
    .select()
    .from(products)
    .where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted')))
    .orderBy(products.name);

export async function getProduct(id: string) {
  const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!row || row.status === 'deleted') throw notFound('Product');
  return row;
}

export const listProductCategories = () => db.select().from(productCategories).orderBy(productCategories.name);

// ─── Cart pricing ────────────────────────────────────────────────────────────

/** Delivery fee: per started kilometre, minimum 1 km (legacy rule). */
export function deliveryFeeFor(pharmacy: Pick<Pharmacy, 'latitude' | 'longitude' | 'deliveryFeePerKm'>, to: LatLng) {
  if (pharmacy.latitude === null || pharmacy.longitude === null) return null;
  const km = Math.max(1, Math.floor(distanceKm({ latitude: pharmacy.latitude, longitude: pharmacy.longitude }, to)));
  return round2(km * pharmacy.deliveryFeePerKm);
}

/** Prices a cart from live catalogue data, grouped into one order per pharmacy. */
export async function priceCart(input: z.infer<typeof cartSchema>) {
  const ids = input.items.map((i) => i.productId);
  const rows = await db
    .select({ product: products, pharmacy: pharmacies })
    .from(products)
    .innerJoin(pharmacies, eq(pharmacies.id, products.pharmacyId))
    .where(and(inArray(products.id, ids), ne(products.status, 'deleted'), ne(pharmacies.status, 'deleted')));
  const byId = new Map(rows.map((r) => [r.product.id, r]));

  const groups = new Map<string, { pharmacy: Pharmacy; lines: Array<{ product: typeof products.$inferSelect; quantity: number }> }>();
  for (const item of input.items) {
    const row = byId.get(item.productId);
    if (!row) throw badRequest('Some products are unavailable', [{ path: 'items', message: `${item.productId} not found` }]);
    if (row.product.stockRemaining < item.quantity) {
      throw unprocessable('OUT_OF_STOCK', `Only ${row.product.stockRemaining} of "${row.product.name}" left in stock`, {
        productId: row.product.id,
        available: row.product.stockRemaining,
      });
    }
    const group = groups.get(row.pharmacy.id) ?? { pharmacy: row.pharmacy, lines: [] };
    group.lines.push({ product: row.product, quantity: item.quantity });
    groups.set(row.pharmacy.id, group);
  }

  const pharmacyOrders = [...groups.values()].map(({ pharmacy, lines }) => {
    const deliveryFee = deliveryFeeFor(pharmacy, input.location);
    if (deliveryFee === null) throw unprocessable('PHARMACY_NOT_DELIVERABLE', `${pharmacy.name} has no delivery location set`);
    const subtotal = round2(lines.reduce((sum, l) => sum + l.product.amount * l.quantity, 0));
    return { pharmacy, lines, subtotal, deliveryFee, totalAmount: round2(subtotal + deliveryFee) };
  });

  const subtotal = round2(pharmacyOrders.reduce((s, o) => s + o.subtotal, 0));
  const deliveryFee = round2(pharmacyOrders.reduce((s, o) => s + o.deliveryFee, 0));
  const surcharge = orderSurcharge(subtotal);
  return {
    currency: PHARMACY_CURRENCY,
    subtotal,
    deliveryFee,
    surcharge,
    totalAmount: round2(subtotal + deliveryFee),
    amountDue: round2(subtotal + deliveryFee + surcharge),
    orders: pharmacyOrders,
  };
}

export async function quoteCart(input: z.infer<typeof cartSchema>) {
  const priced = await priceCart(input);
  return {
    ...priced,
    orders: priced.orders.map((o) => ({
      pharmacyId: o.pharmacy.id,
      pharmacyName: o.pharmacy.name,
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      totalAmount: o.totalAmount,
    })),
  };
}

/** Creates a checkout (awaiting payment). Idempotent per (user, Idempotency-Key). */
export async function createCheckout(userId: string, input: z.infer<typeof checkoutSchema>, idempotencyKey?: string) {
  if (idempotencyKey) {
    const existing = await findCheckoutByKey(userId, idempotencyKey);
    if (existing) return { checkout: existing, created: false };
  }

  const priced = await priceCart(input);
  const checkoutId = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(orderCheckouts).values({
        id: checkoutId,
        userId,
        subtotal: priced.subtotal,
        deliveryFee: priced.deliveryFee,
        totalAmount: priced.totalAmount,
        currency: priced.currency,
        idempotencyKey: idempotencyKey ?? null,
      });
      for (const o of priced.orders) {
        const orderId = newId();
        await tx.insert(orders).values({
          id: orderId,
          checkoutId,
          userId,
          pharmacyId: o.pharmacy.id,
          trackingId: randomCode(8),
          subtotal: o.subtotal,
          deliveryFee: o.deliveryFee,
          totalAmount: o.totalAmount,
          address: input.address,
          latitude: input.location.latitude,
          longitude: input.location.longitude,
        });
        await tx.insert(orderItems).values(
          o.lines.map((l) => ({
            id: newId(),
            orderId,
            productId: l.product.id,
            name: l.product.name,
            unitPrice: l.product.amount,
            discount: l.product.discount,
            quantity: l.quantity,
            image: l.product.images[0] ?? null,
          })),
        );
      }
    });
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const existing = await findCheckoutByKey(userId, idempotencyKey);
      if (existing) return { checkout: existing, created: false };
    }
    // An 8-char tracking id collision (~1 in 10^12) surfaces as a retryable 5xx.
    throw err;
  }
  return { checkout: (await getCheckout(userId, checkoutId))!, created: true };
}

async function findCheckoutByKey(userId: string, key: string) {
  const [row] = await db
    .select({ id: orderCheckouts.id })
    .from(orderCheckouts)
    .where(and(eq(orderCheckouts.userId, userId), eq(orderCheckouts.idempotencyKey, key)))
    .limit(1);
  return row ? getCheckout(userId, row.id) : null;
}

async function getCheckout(userId: string, checkoutId: string) {
  const [checkout] = await db
    .select()
    .from(orderCheckouts)
    .where(and(eq(orderCheckouts.id, checkoutId), eq(orderCheckouts.userId, userId)));
  if (!checkout) return null;
  const checkoutOrders = await attachItems(await db.select().from(orders).where(eq(orders.checkoutId, checkoutId)));
  return {
    ...checkout,
    surcharge: orderSurcharge(checkout.subtotal),
    amountDue: round2(checkout.totalAmount + orderSurcharge(checkout.subtotal)),
    orders: checkoutOrders,
  };
}

async function attachItems(orderRows: Array<typeof orders.$inferSelect>) {
  if (orderRows.length === 0) return [];
  const items = await db.select().from(orderItems).where(inArray(orderItems.orderId, orderRows.map((o) => o.id)));
  return orderRows.map((o) => ({ ...o, items: items.filter((i) => i.orderId === o.id) }));
}

export async function listOrders(
  userId: string,
  query: { limit: number; offset: number; status?: (typeof orders.$inferSelect)['status'] },
) {
  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        query.status ? eq(orders.status, query.status) : ne(orders.status, 'awaiting_payment'),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  return attachItems(rows);
}

export async function getOrder(userId: string, orderId: string) {
  const [row] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId))).limit(1);
  if (!row) throw notFound('Order');
  const [withItems] = await attachItems([row]);
  return withItems;
}
