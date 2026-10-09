import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { orderCheckouts, orderEvents, orderItems, orders, pharmacies, products, users } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken, signPharmacyAccessToken } from '../../src/lib/tokens.js';
import { confirmCheckout } from '../../src/modules/payments/fulfillment.js';
import { api, createUser, resetDatabase } from '../helpers.js';

const portal = (pharmacyId: string) => {
  const token = signPharmacyAccessToken(pharmacyId);
  return {
    get: (path: string) => api().get(`/api/v1/pharmacy-portal${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      api().post(`/api/v1/pharmacy-portal${path}`).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) =>
      api().patch(`/api/v1/pharmacy-portal${path}`).set('Authorization', `Bearer ${token}`).send(body),
  };
};

const allWeek = { open: '00:00', close: '23:59' };
const everyDay = { mon: allWeek, tue: allWeek, wed: allWeek, thu: allWeek, fri: allWeek, sat: allWeek, sun: allWeek };

async function createPharmacy(overrides: Partial<typeof pharmacies.$inferInsert> = {}) {
  const id = newId();
  await db.insert(pharmacies).values({
    id,
    name: 'SpringZone',
    email: `${id}@pharmacy.test`,
    latitude: 4.95,
    longitude: 8.32,
    deliveryFeePerKm: 100,
    status: 'active',
    openingHours: everyDay,
    ...overrides,
  });
  const productId = newId();
  await db.insert(products).values({
    id: productId,
    pharmacyId: id,
    name: 'Paracetamol',
    amount: 1000,
    stockRemaining: 10,
    images: [],
  });
  return { id, productId };
}

/** A paid order for [userId], confirmed through the real payment fulfilment. */
async function paidOrder(userId: string, pharmacyId: string, productId: string) {
  const checkoutId = newId();
  const orderId = newId();
  await db.insert(orderCheckouts).values({ id: checkoutId, userId, subtotal: 2000, deliveryFee: 100, totalAmount: 2100, currency: 'NGN' });
  await db.insert(orders).values({
    id: orderId,
    checkoutId,
    userId,
    pharmacyId,
    trackingId: orderId.slice(0, 10).toUpperCase(),
    subtotal: 2000,
    deliveryFee: 100,
    totalAmount: 2100,
    address: '1 Marian Road, Calabar',
  });
  await db.insert(orderItems).values({ id: newId(), orderId, productId, name: 'Paracetamol', unitPrice: 1000, quantity: 2 });
  await db.transaction((tx) => confirmCheckout(tx, checkoutId));
  return orderId;
}

describe('pharmacy marketplace', () => {
  beforeEach(resetDatabase);

  it('lists only live pharmacies, with store status and rating', async () => {
    await createPharmacy({ name: 'Live' });
    await createPharmacy({ name: 'Draft', status: 'onboarding' });
    const user = await createUser();
    const res = await api()
      .get('/api/v1/pharmacies?latitude=4.95&longitude=8.32&radiusKm=10')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((p: { name: string }) => p.name)).toEqual(['Live']);
    expect(res.body.items[0]).toMatchObject({ isOpen: true, storeState: 'open', rating: null, ratingCount: 0 });
  });

  it('will not price a cart from a pharmacy that switched off orders', async () => {
    const { id, productId } = await createPharmacy({ acceptingOrders: false });
    const user = await createUser();
    const res = await api()
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ items: [{ productId, quantity: 1 }], location: { latitude: 4.96, longitude: 8.33 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PHARMACY_CLOSED');
    // Switching back on from the workspace reopens it.
    await portal(id).patch('/availability', { acceptingOrders: true }).expect(200);
    const again = await api()
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ items: [{ productId, quantity: 1 }], location: { latitude: 4.96, longitude: 8.33 } });
    expect(again.status).toBe(200);
  });

  it('uses the admin-configured surcharge in patient cart quotes', async () => {
    const { productId } = await createPharmacy();
    const user = await createUser();
    const adminToken = signAdminAccessToken({ sub: newId(), role: 'admin' });
    await api()
      .put('/api/v1/admin/commercial-fees')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        gatewayFeePercent: 0,
        orderSurchargePercent: 3,
        consultationPlatformPercent: 40,
        pharmacyPlatformPercent: 5,
        referralCommissionPercent: 10,
      })
      .expect(200);

    const quote = await api()
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ items: [{ productId, quantity: 2 }], location: { latitude: 4.96, longitude: 8.33 } })
      .expect(200);
    expect(quote.body).toMatchObject({ subtotal: 2000, surcharge: 60 });
    expect(quote.body.amountDue).toBe(quote.body.totalAmount + 60);
  });

  it('requires setup before going live', async () => {
    const { id } = await createPharmacy({ status: 'onboarding', image: null, coverImage: null, phoneNumber: null });
    const p = portal(id);
    const me = await p.get('/me');
    expect(me.body.setup.complete).toBe(false);
    expect((await p.post('/go-live')).status).toBe(400);

    await p
      .patch('/profile', {
        image: 'https://cdn.test/logo.png',
        coverImage: 'https://cdn.test/cover.png',
        phoneNumber: '08012345678',
        address: 'Calabar',
        openingHours: { mon: { open: '08:00', close: '20:00' }, sun: null },
      })
      .expect(200);
    const live = await p.post('/go-live');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'active', setup: { complete: true } });
  });

  it('runs an order from payment to delivery with a timeline', async () => {
    const { id, productId } = await createPharmacy();
    const user = await createUser({ email: 'ada@test.local' });
    const orderId = await paidOrder(user.id, id, productId);
    const p = portal(id);

    expect((await p.get('/pulse')).body.pendingOrders).toBe(1);
    await p.post(`/orders/${orderId}/actions`, { action: 'accept', etaMinutes: 40 }).expect(200);
    await p.post(`/orders/${orderId}/actions`, { action: 'dispatch', riderName: 'Musa', riderPhone: '0801' }).expect(200);
    // Can't skip back.
    expect((await p.post(`/orders/${orderId}/actions`, { action: 'accept', etaMinutes: 10 })).status).toBe(400);

    const mine = await api().get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${user.token}`);
    expect(mine.body).toMatchObject({ status: 'delivering', etaMinutes: 40, riderName: 'Musa', canConfirmDelivery: true });
    expect(mine.body.events.map((e: { status: string }) => e.status)).toEqual(['pending', 'processing', 'delivering']);

    // The customer confirms receipt, then reviews and reports a problem.
    await api().post(`/api/v1/orders/${orderId}/confirm-delivery`).set('Authorization', `Bearer ${user.token}`).expect(200);
    const reviewed = await api()
      .post(`/api/v1/orders/${orderId}/review`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ rating: 4, comment: 'Quick delivery' });
    expect(reviewed.status).toBe(201);
    expect(reviewed.body).toMatchObject({ canReview: false, review: { rating: 4 } });
    expect(
      (await api().post(`/api/v1/orders/${orderId}/review`).set('Authorization', `Bearer ${user.token}`).send({ rating: 5 })).status,
    ).toBe(409);

    const reported = await api()
      .post(`/api/v1/orders/${orderId}/issues`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ category: 'missing_item', message: 'One strip was missing' });
    expect(reported.status).toBe(201);

    const issues = await p.get('/issues?status=open');
    expect(issues.body.total).toBe(1);
    await p.post(`/issues/${issues.body.items[0].id}/respond`, { response: 'Sending it now', resolve: true }).expect(200);
    const after = await api().get(`/api/v1/orders/${orderId}`).set('Authorization', `Bearer ${user.token}`);
    expect(after.body.issues[0]).toMatchObject({ status: 'resolved', response: 'Sending it now' });

    const reviews = await p.get('/reviews');
    expect(reviews.body).toMatchObject({ rating: 4, ratingCount: 1 });
    await p.post(`/reviews/${reviews.body.items[0].id}/reply`, { reply: 'Thank you!' }).expect(200);
    const publicReviews = await api().get(`/api/v1/pharmacies/${id}/reviews`).set('Authorization', `Bearer ${user.token}`);
    expect(publicReviews.body.items[0]).toMatchObject({ rating: 4, reply: 'Thank you!', author: 'Test' });
  });

  it('refunds the customer when the pharmacy cancels', async () => {
    const { id, productId } = await createPharmacy();
    const user = await createUser();
    const orderId = await paidOrder(user.id, id, productId);
    const res = await portal(id).post(`/orders/${orderId}/actions`, { action: 'cancel', reason: 'Out of stock' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'Out of stock' });
    const [u] = await db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, user.id));
    // 2,100 for goods and delivery + 2% service charge on the 2,000 goods.
    expect(u?.balance).toBe(2140);
    const events = await db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId));
    expect(events.map((e) => e.status)).toEqual(['pending', 'cancelled']);
  });
});
