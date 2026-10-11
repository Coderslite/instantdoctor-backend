import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../src/db/client.js';
import { inventoryMovements, pharmacies, pharmacyStaff, products } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signPharmacyAccessToken, signPharmacyStaffAccessToken } from '../../src/lib/tokens.js';
import { api, resetDatabase } from '../helpers.js';

const base = '/api/v1/pharmacy-portal';

async function setup() {
  const pharmacyId = newId();
  await db.insert(pharmacies).values({ id: pharmacyId, name: 'Counter Pharmacy', email: `${pharmacyId}@pharmacy.test` });
  const productId = newId();
  await db.insert(products).values({ id: productId, pharmacyId, name: 'Paracetamol 500mg', sku: 'PCM500', amount: 250, purchasePrice: 150, stockRemaining: 10, images: [] });
  const staffId = newId();
  await db.insert(pharmacyStaff).values({ id: staffId, pharmacyId, name: 'Ada Cashier', email: `${staffId}@staff.test`, role: 'sales_assistant' });
  return {
    pharmacyId,
    productId,
    owner: `Bearer ${signPharmacyAccessToken(pharmacyId)}`,
    cashier: `Bearer ${signPharmacyStaffAccessToken(pharmacyId, staffId, 0)}`,
  };
}

const sale = (productId: string, overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  receiptNumber: `T1-${Math.floor(Math.random() * 1e6)}`,
  items: [{ productId, name: 'Paracetamol 500mg', sku: 'PCM500', unitPrice: 250, discount: 10, quantity: 3 }],
  payments: [{ method: 'cash', amount: 1000 }],
  total: 675,
  soldAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...overrides,
});

const stockOf = async (id: string) => (await db.select().from(products).where(eq(products.id, id)))[0]!.stockRemaining;

describe('pharmacy point of sale', () => {
  beforeEach(resetDatabase);

  it('records an offline sale once, however often it is retried', async () => {
    const { productId, cashier } = await setup();
    const body = { deviceId: 'till-1', sales: [sale(productId)] };
    const first = await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send(body);
    expect(first.status).toBe(200);
    expect(first.body.results[0]).toMatchObject({ status: 'synced' });
    expect(first.body.results[0].sale).toMatchObject({ subtotal: 750, discountTotal: 75, total: 675, amountTendered: 1000, changeDue: 325, cashierName: 'Ada Cashier' });
    expect(first.body.results[0].sale.items[0].unitCost).toBeNull();

    const again = await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send(body);
    expect(again.body.results[0].status).toBe('duplicate');
    expect(await stockOf(productId)).toBe(7);
  });

  it('rejects a sale whose total does not match its lines without blocking the rest', async () => {
    const { productId, cashier } = await setup();
    const res = await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send({
      deviceId: 'till-1',
      sales: [sale(productId, { total: 1 }), sale(productId)],
    });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['rejected', 'synced']);
    expect(await stockOf(productId)).toBe(7);
  });

  it('keeps a sale that oversold stock and flags the shortfall', async () => {
    const { productId, owner } = await setup();
    const res = await api().post(`${base}/pos/sales/sync`).set('Authorization', owner).send({
      deviceId: 'till-1',
      sales: [sale(productId, { items: [{ productId, name: 'Paracetamol 500mg', unitPrice: 250, quantity: 12 }], total: 3000, payments: [{ method: 'transfer', amount: 3000 }] })],
    });
    expect(res.body.results[0].status).toBe('synced');
    expect(res.body.results[0].sale.stockWarnings).toEqual([{ productId, name: 'Paracetamol 500mg', requested: 12, available: 10 }]);
    expect(await stockOf(productId)).toBe(0);
  });

  it('refuses change on card payments and whole-sale discounts from cashiers', async () => {
    const { productId, cashier } = await setup();
    const res = await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send({
      deviceId: 'till-1',
      sales: [
        sale(productId, { payments: [{ method: 'card', amount: 1000 }] }),
        sale(productId, { saleDiscount: 75, total: 600 }),
      ],
    });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['rejected', 'rejected']);
  });

  it('voids a sale, restocks it and reports the day', async () => {
    const { productId, owner, cashier } = await setup();
    const kept = sale(productId);
    const voided = sale(productId, { payments: [{ method: 'card', amount: 675 }] });
    await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send({ deviceId: 'till-1', sales: [kept, voided] });
    expect(await stockOf(productId)).toBe(4);

    expect((await api().post(`${base}/pos/sales/${voided.id}/void`).set('Authorization', cashier).send({ reason: 'Wrong item' })).status).toBe(403);
    const res = await api().post(`${base}/pos/sales/${voided.id}/void`).set('Authorization', owner).send({ reason: 'Customer returned it' });
    expect(res.body).toMatchObject({ status: 'voided', voidReason: 'Customer returned it', voidedByName: 'Counter Pharmacy' });
    expect(await stockOf(productId)).toBe(7);
    const movements = await db.select().from(inventoryMovements).where(eq(inventoryMovements.productId, productId));
    expect(movements.reduce((sum, m) => sum + m.quantity, 0)).toBe(-3);

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const report = await api().get(`${base}/pos/summary`).query({ from, to }).set('Authorization', owner);
    expect(report.body).toMatchObject({ salesCount: 1, net: 675, costOfGoods: 450, grossProfit: 225, voidedCount: 1, voidedTotal: 675, payments: [{ method: 'cash', amount: 675 }] });
  });

  it('fails the request instead of refusing sales when the database errors', async () => {
    const { productId, cashier } = await setup();
    await pool.query('RENAME TABLE pos_sale_items TO pos_sale_items_off');
    try {
      const res = await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send({ deviceId: 'till-1', sales: [sale(productId)] });
      expect(res.status).toBe(500);
    } finally {
      await pool.query('RENAME TABLE pos_sale_items_off TO pos_sale_items');
    }
    expect(await stockOf(productId)).toBe(10);
  });

    it('shows cashiers only their own sales and hides costs from them', async () => {
    const { productId, owner, cashier } = await setup();
    await api().post(`${base}/pos/sales/sync`).set('Authorization', owner).send({ deviceId: 'till-1', sales: [sale(productId)] });
    await api().post(`${base}/pos/sales/sync`).set('Authorization', cashier).send({ deviceId: 'till-2', sales: [sale(productId)] });
    expect((await api().get(`${base}/pos/sales`).set('Authorization', owner)).body.total).toBe(2);
    const mine = await api().get(`${base}/pos/sales`).set('Authorization', cashier);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].items[0].unitCost).toBeNull();
    const catalog = await api().get(`${base}/pos/catalog`).set('Authorization', cashier);
    expect(catalog.body.items[0]).toMatchObject({ id: productId, purchasePrice: null, stockRemaining: 4 });
  });

  it('applies an offline stock adjustment once', async () => {
    const { productId, owner } = await setup();
    const body = { id: randomUUID(), quantity: -2, reason: 'Damaged' };
    await api().post(`${base}/products/${productId}/stock`).set('Authorization', owner).send(body);
    const again = await api().post(`${base}/products/${productId}/stock`).set('Authorization', owner).send(body);
    expect(again.body).toEqual({ id: productId, stockRemaining: 8 });
  });
});
