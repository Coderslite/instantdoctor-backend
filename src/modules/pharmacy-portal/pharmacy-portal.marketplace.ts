import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import {
  orderEvents,
  orderIssues,
  orderItems,
  orderCheckouts,
  orders,
  payments,
  pharmacies,
  pharmacyReviews,
  products,
  users,
  type OpeningHours,
} from '../../db/schema/index.js';
import { sendPush } from '../../integrations/push.js';
import { issueLabel } from '../../integrations/mail/templates.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { createNotification } from '../notifications/notifications.service.js';
import { runEffects, type Effect } from '../payments/effects.js';
import { getFeePolicy, orderSurcharge } from '../pricing/fees.js';
import { credit } from '../wallet/wallet.ledger.js';
import { resolveFileUrl } from '../files/files.service.js';
import {
  averageRating,
  cleanOpeningHours,
  customerOrderUpdate,
  formatNaira,
  recordOrderEvent,
  setupChecklist,
  setupComplete,
  storeStatus,
} from '../pharmacy/marketplace.js';

type Pharmacy = typeof pharmacies.$inferSelect;
type OrderStatus = (typeof orders.$inferSelect)['status'];

async function load(pharmacyId: string): Promise<Pharmacy> {
  const [p] = await db.select().from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
  if (!p) throw notFound('Pharmacy');
  return p;
}

const activeProductCount = async (pharmacyId: string) =>
  (
    await db
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.pharmacyId, pharmacyId), eq(products.status, 'active'), sql`${products.stockRemaining} > 0`))
  )[0]?.value ?? 0;

/** Everything the workspace needs about the store itself. */
export async function storeProfile(pharmacyId: string) {
  const p = await load(pharmacyId);
  const setup = setupChecklist(p, await activeProductCount(pharmacyId));
  const store = storeStatus(p);
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    phoneNumber: p.phoneNumber,
    address: p.address,
    latitude: p.latitude,
    longitude: p.longitude,
    deliveryFeePerKm: p.deliveryFeePerKm,
    discount: p.discount,
    image: await resolveFileUrl(p.image),
    coverImage: await resolveFileUrl(p.coverImage),
    description: p.description,
    openingHours: p.openingHours,
    timeZone: p.timeZone,
    acceptingOrders: p.acceptingOrders,
    deliveryMinutes: p.deliveryMinutes,
    balance: p.balance,
    status: p.status,
    liveAt: p.liveAt,
    rating: averageRating(p),
    ratingCount: p.ratingCount,
    isOpen: store.open,
    storeState: store.state,
    storeLabel: store.label,
    setup: { items: setup, complete: setupComplete(setup) },
  };
}

export async function updateStore(
  pharmacyId: string,
  input: Partial<Pick<Pharmacy, 'coverImage' | 'description' | 'timeZone' | 'deliveryMinutes'>> & {
    openingHours?: OpeningHours | null;
  },
) {
  const patch: Partial<Pharmacy> = { ...input } as Partial<Pharmacy>;
  if (input.openingHours !== undefined) {
    try {
      patch.openingHours = input.openingHours === null ? null : cleanOpeningHours(input.openingHours);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  }
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timeZone });
    } catch {
      throw badRequest('Unknown time zone');
    }
  }
  if (Object.keys(patch).length) await db.update(pharmacies).set(patch).where(eq(pharmacies.id, pharmacyId));
  return storeProfile(pharmacyId);
}

/** Turns order taking on or off without touching opening hours. */
export async function setAvailability(pharmacyId: string, acceptingOrders: boolean) {
  await db.update(pharmacies).set({ acceptingOrders }).where(eq(pharmacies.id, pharmacyId));
  return storeProfile(pharmacyId);
}

/** Publishes the store once every setup step is done. */
export async function goLive(pharmacyId: string) {
  const p = await load(pharmacyId);
  if (p.status === 'active') return storeProfile(pharmacyId);
  if (p.status !== 'onboarding') throw badRequest('This store can’t be published. Contact Instant Doctor support.');
  const setup = setupChecklist(p, await activeProductCount(pharmacyId));
  const missing = setup.filter((i) => !i.done).map((i) => i.label);
  if (missing.length) throw badRequest(`Finish setup first: ${missing.join(', ')}`);
  await db.update(pharmacies).set({ status: 'active', liveAt: new Date() }).where(eq(pharmacies.id, pharmacyId));
  return storeProfile(pharmacyId);
}

/** Takes a live store off the marketplace (e.g. for maintenance). */
export async function goOffline(pharmacyId: string) {
  const p = await load(pharmacyId);
  if (p.status !== 'active') return storeProfile(pharmacyId);
  await db.update(pharmacies).set({ status: 'onboarding' }).where(eq(pharmacies.id, pharmacyId));
  return storeProfile(pharmacyId);
}

// ─── Orders ──────────────────────────────────────────────────────────────────

async function lockOwnOrder(tx: Tx, pharmacyId: string, id: string) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.pharmacyId, pharmacyId)))
    .for('update');
  if (!order) throw notFound('Order');
  return order;
}

function expect(order: { status: OrderStatus }, allowed: OrderStatus[], action: string) {
  if (!allowed.includes(order.status)) {
    throw badRequest(`This order is ${order.status.replace('_', ' ')} and can’t be ${action}`);
  }
}

export type OrderAction =
  | { action: 'accept'; etaMinutes: number }
  | { action: 'dispatch'; riderName: string; riderPhone?: string | null }
  | { action: 'deliver' }
  | { action: 'cancel'; reason: string };

/**
 * Moves an order through fulfilment — accept → dispatch → deliver, or cancel
 * with a reason (refunded to the customer's wallet) — recording each step and
 * telling the customer by in-app notification, push and email.
 */
export async function actOnOrder(pharmacyId: string, id: string, input: OrderAction) {
  const effects: Effect[] = await db.transaction(async (tx) => {
    const order = await lockOwnOrder(tx, pharmacyId, id);
    switch (input.action) {
      case 'accept': {
        expect(order, ['pending'], 'accepted');
        await tx.update(orders).set({ status: 'processing', etaMinutes: input.etaMinutes }).where(eq(orders.id, id));
        await recordOrderEvent(tx, id, 'processing', 'pharmacy', `Accepted · ready in about ${input.etaMinutes} min`);
        return customerOrderUpdate(tx, id, 'processing');
      }
      case 'dispatch': {
        expect(order, ['processing'], 'sent out');
        await tx
          .update(orders)
          .set({ status: 'delivering', riderName: input.riderName, riderPhone: input.riderPhone ?? null })
          .where(eq(orders.id, id));
        await recordOrderEvent(
          tx,
          id,
          'delivering',
          'pharmacy',
          `Out for delivery with ${input.riderName}${input.riderPhone ? ` (${input.riderPhone})` : ''}`,
        );
        return customerOrderUpdate(tx, id, 'delivering', {
          note: `${input.riderName}${input.riderPhone ? ` (${input.riderPhone})` : ''} is bringing your order.`,
        });
      }
      case 'deliver': {
        expect(order, ['delivering'], 'marked delivered');
        await tx.update(orders).set({ status: 'completed' }).where(eq(orders.id, id));
        await recordOrderEvent(tx, id, 'completed', 'pharmacy', 'Delivered');
        return customerOrderUpdate(tx, id, 'completed');
      }
      case 'cancel': {
        expect(order, ['pending', 'processing'], 'cancelled');
        await tx.update(orders).set({ status: 'cancelled', cancelReason: input.reason }).where(eq(orders.id, id));
        // Refund what the customer paid for this order: goods, delivery and
        // its share of the service charge, to their Instant Doctor wallet.
        let checkoutSurcharge: number;
        if (order.checkoutId) {
          const [checkout] = await tx
            .select({ subtotal: orderCheckouts.subtotal })
            .from(orderCheckouts)
            .where(eq(orderCheckouts.id, order.checkoutId))
            .limit(1);
          const [payment] = await tx
            .select({ surcharge: payments.surcharge })
            .from(payments)
            .where(
              and(
                eq(payments.purpose, 'order_checkout'),
                eq(payments.purposeRefId, order.checkoutId),
                eq(payments.status, 'succeeded'),
              ),
            )
            .orderBy(desc(payments.paidAt))
            .limit(1);
          checkoutSurcharge =
            checkout && payment && checkout.subtotal > 0
              ? Math.round((payment.surcharge * order.subtotal / checkout.subtotal) * 100) / 100
              : orderSurcharge(order.subtotal, await getFeePolicy(tx));
        } else {
          checkoutSurcharge = orderSurcharge(order.subtotal, await getFeePolicy(tx));
        }
        const refund = Math.round((order.totalAmount + checkoutSurcharge) * 100) / 100;
        await credit(tx, {
          userId: order.userId,
          amount: refund,
          title: `Refund for cancelled order ${order.trackingId}`,
        });
        await recordOrderEvent(tx, id, 'cancelled', 'pharmacy', `Cancelled: ${input.reason}`);
        return customerOrderUpdate(tx, id, 'cancelled', {
          note: `Reason: ${input.reason}. ${formatNaira(refund)} has been refunded to your Instant Doctor wallet.`,
        });
      }
    }
  });
  await runEffects(effects);
  return orderDetail(pharmacyId, id);
}

/** Order with customer, items, timeline, review and reported problems. */
export async function orderDetail(pharmacyId: string, id: string) {
  const [order] = await db
    .select({
      order: orders,
      customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`,
      customerEmail: users.email,
      customerPhone: users.phoneNumber,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(and(eq(orders.id, id), eq(orders.pharmacyId, pharmacyId)))
    .limit(1);
  if (!order) throw notFound('Order');
  const [items, events, [review], issues] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, id)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(orderEvents.createdAt),
    db.select().from(pharmacyReviews).where(eq(pharmacyReviews.orderId, id)).limit(1),
    db.select().from(orderIssues).where(eq(orderIssues.orderId, id)).orderBy(desc(orderIssues.createdAt)),
  ]);
  return {
    ...order.order,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    items,
    events,
    review: review ?? null,
    issues: issues.map((i) => ({ ...i, label: issueLabel(i.category) })),
  };
}

/** What needs attention now — polled by the workspace for new-order alerts. */
export async function pulse(pharmacyId: string) {
  const [[pending], [issues], [latest]] = await Promise.all([
    db.select({ value: count() }).from(orders).where(and(eq(orders.pharmacyId, pharmacyId), eq(orders.status, 'pending'))),
    db
      .select({ value: count() })
      .from(orderIssues)
      .where(and(eq(orderIssues.pharmacyId, pharmacyId), eq(orderIssues.status, 'open'))),
    db
      .select({ id: orders.id, trackingId: orders.trackingId, createdAt: orders.createdAt, totalAmount: orders.totalAmount })
      .from(orders)
      .where(and(eq(orders.pharmacyId, pharmacyId), eq(orders.status, 'pending')))
      .orderBy(desc(orders.createdAt))
      .limit(1),
  ]);
  const p = await load(pharmacyId);
  const store = storeStatus(p);
  return {
    pendingOrders: pending?.value ?? 0,
    openIssues: issues?.value ?? 0,
    latestPending: latest ?? null,
    isOpen: store.open,
    storeState: store.state,
    storeLabel: store.label,
    acceptingOrders: p.acceptingOrders,
  };
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

export async function listReviews(pharmacyId: string, query: { limit: number; offset: number }) {
  const where = eq(pharmacyReviews.pharmacyId, pharmacyId);
  const [items, [total], p] = await Promise.all([
    db
      .select({
        id: pharmacyReviews.id,
        rating: pharmacyReviews.rating,
        comment: pharmacyReviews.comment,
        reply: pharmacyReviews.reply,
        repliedAt: pharmacyReviews.repliedAt,
        createdAt: pharmacyReviews.createdAt,
        trackingId: orders.trackingId,
        customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`,
      })
      .from(pharmacyReviews)
      .innerJoin(orders, eq(orders.id, pharmacyReviews.orderId))
      .innerJoin(users, eq(users.id, pharmacyReviews.userId))
      .where(where)
      .orderBy(desc(pharmacyReviews.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(pharmacyReviews).where(where),
    load(pharmacyId),
  ]);
  const breakdown = await db
    .select({ rating: pharmacyReviews.rating, value: count() })
    .from(pharmacyReviews)
    .where(where)
    .groupBy(pharmacyReviews.rating);
  return {
    items,
    total: total?.value ?? 0,
    rating: averageRating(p),
    ratingCount: p.ratingCount,
    breakdown: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, breakdown.find((b) => b.rating === r)?.value ?? 0])),
  };
}

export async function replyToReview(pharmacyId: string, id: string, reply: string) {
  const [review] = await db
    .select()
    .from(pharmacyReviews)
    .where(and(eq(pharmacyReviews.id, id), eq(pharmacyReviews.pharmacyId, pharmacyId)))
    .limit(1);
  if (!review) throw notFound('Review');
  await db.update(pharmacyReviews).set({ reply: reply.trim(), repliedAt: new Date() }).where(eq(pharmacyReviews.id, id));
  const [user] = await db.select({ token: users.fcmToken }).from(users).where(eq(users.id, review.userId)).limit(1);
  const [p] = await db.select({ name: pharmacies.name }).from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
  void sendPush([user?.token], {
    title: `${p?.name ?? 'The pharmacy'} replied to your review`,
    body: reply.trim().slice(0, 140),
    data: { type: 'order', id: review.orderId },
  });
  return { ...review, reply: reply.trim(), repliedAt: new Date() };
}

// ─── Reported problems ───────────────────────────────────────────────────────

export async function listIssues(pharmacyId: string, query: { status?: 'open' | 'resolved'; limit: number; offset: number }) {
  const where = and(
    eq(orderIssues.pharmacyId, pharmacyId),
    query.status ? eq(orderIssues.status, query.status) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select({
        issue: orderIssues,
        trackingId: orders.trackingId,
        customerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`,
        customerPhone: users.phoneNumber,
      })
      .from(orderIssues)
      .innerJoin(orders, eq(orders.id, orderIssues.orderId))
      .innerJoin(users, eq(users.id, orderIssues.userId))
      .where(where)
      .orderBy(desc(orderIssues.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(orderIssues).where(where),
  ]);
  return {
    items: items.map((r) => ({
      ...r.issue,
      label: issueLabel(r.issue.category),
      trackingId: r.trackingId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
    })),
    total: total?.value ?? 0,
  };
}

/** Responds to (and optionally resolves) a problem; the customer is notified. */
export async function respondToIssue(pharmacyId: string, id: string, input: { response: string; resolve: boolean }) {
  const [issue] = await db
    .select()
    .from(orderIssues)
    .where(and(eq(orderIssues.id, id), eq(orderIssues.pharmacyId, pharmacyId)))
    .limit(1);
  if (!issue) throw notFound('Report');
  const response = input.response.trim();
  const status = input.resolve ? 'resolved' : issue.status;
  const effects = await db.transaction(async (tx) => {
    await tx
      .update(orderIssues)
      .set({ response, respondedAt: new Date(), status })
      .where(eq(orderIssues.id, id));
    const [[order], [user], [p]] = await Promise.all([
      tx.select({ trackingId: orders.trackingId }).from(orders).where(eq(orders.id, issue.orderId)),
      tx.select({ token: users.fcmToken }).from(users).where(eq(users.id, issue.userId)),
      tx.select({ name: pharmacies.name }).from(pharmacies).where(eq(pharmacies.id, pharmacyId)),
    ]);
    const title = `${p?.name ?? 'The pharmacy'} responded to your report${status === 'resolved' ? ' · resolved' : ''}`;
    return [
      await createNotification({ userId: issue.userId, type: 'transaction', title: `${title} · ${order?.trackingId ?? ''}` }, tx),
      () => sendPush([user?.token], { title, body: response.slice(0, 160), data: { type: 'order', id: issue.orderId } }),
    ];
  });
  await runEffects(effects);
  return { ...issue, response, status, respondedAt: new Date(), label: issueLabel(issue.category) };
}

/** Orders still needing action, grouped for the fulfilment board. */
export async function boardCounts(pharmacyId: string) {
  const rows = await db
    .select({ status: orders.status, value: count() })
    .from(orders)
    .where(and(eq(orders.pharmacyId, pharmacyId), ne(orders.status, 'awaiting_payment')))
    .groupBy(orders.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.value]));
  return {
    pending: by.pending ?? 0,
    processing: by.processing ?? 0,
    delivering: by.delivering ?? 0,
    completed: by.completed ?? 0,
    cancelled: by.cancelled ?? 0,
  };
}
