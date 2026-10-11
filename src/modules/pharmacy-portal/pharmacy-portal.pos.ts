import { and, count, desc, eq, gte, inArray, like, lt, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import {
  inventoryMovements,
  pharmacyStaff,
  posSaleItems,
  posSales,
  productCategories,
  products,
  type PosPayment,
  type PosStockWarning,
} from '../../db/schema/index.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';
import { posSaleSchema } from './pharmacy-portal.schemas.js';

type SaleInput = z.infer<typeof posSaleSchema>;
type Role = 'owner' | 'manager' | 'pharmacist' | 'inventory_officer' | 'sales_assistant';
export type Cashier = { pharmacyId: string; staffId?: string; role: Role };

export const isManagerRole = (role: Role) => role === 'owner' || role === 'manager';

/** Name printed on receipts: the staff member's name, or the pharmacy for the owner account. */
export async function accountName(cashier: Cashier, pharmacyName: string) {
  if (!cashier.staffId) return pharmacyName;
  const [staff] = await db.select({ name: pharmacyStaff.name }).from(pharmacyStaff).where(eq(pharmacyStaff.id, cashier.staffId)).limit(1);
  return staff?.name ?? 'Staff';
}

/**
 * The single pricing rule shared with the till. Each line rounds on its own,
 * then the sale discount comes off the discounted lines.
 */
export function priceSale(items: Array<{ unitPrice: number; discount: number; quantity: number }>, saleDiscount: number) {
  const lines = items.map((item) => {
    const gross = round2(item.unitPrice * item.quantity);
    return { gross, lineTotal: round2((gross * (100 - item.discount)) / 100) };
  });
  const subtotal = round2(lines.reduce((sum, line) => sum + line.gross, 0));
  const afterLines = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  if (saleDiscount > afterLines) throw badRequest('The sale discount is larger than the sale');
  const total = round2(afterLines - saleDiscount);
  return { lines, subtotal, discountTotal: round2(subtotal - total), total };
}

/** Every sellable product, with what a till needs to work without a connection. */
export async function catalog(pharmacyId: string, includeCosts: boolean) {
  const items = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      categoryName: productCategories.name,
      name: products.name,
      sku: products.sku,
      manufacturer: products.manufacturer,
      batchNumber: products.batchNumber,
      expiryDate: products.expiryDate,
      description: products.description,
      amount: products.amount,
      purchasePrice: products.purchasePrice,
      discount: products.discount,
      stockRemaining: products.stockRemaining,
      reorderLevel: products.reorderLevel,
      images: products.images,
      status: products.status,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
    .where(and(eq(products.pharmacyId, pharmacyId), ne(products.status, 'deleted')))
    .orderBy(products.name)
    .limit(20_000);
  return {
    items: includeCosts ? items : items.map((item) => ({ ...item, purchasePrice: null })),
    generatedAt: new Date().toISOString(),
  };
}

type SyncResult =
  | { id: string; status: 'synced' | 'duplicate'; sale: Awaited<ReturnType<typeof getSale>> }
  | { id: string | null; status: 'rejected'; error: string };

/**
 * Records sales rung up at the till, most of them possibly hours old. Each
 * sale stands alone: one bad sale is rejected without blocking the rest.
 */
export async function syncSales(cashier: Cashier, cashierName: string, deviceId: string, raw: unknown[]) {
  const results: SyncResult[] = [];
  for (const candidate of raw) {
    const parsed = posSaleSchema.safeParse(candidate);
    const candidateId = typeof candidate === 'object' && candidate !== null && 'id' in candidate && typeof candidate.id === 'string' ? candidate.id : null;
    if (!parsed.success) {
      results.push({ id: candidateId, status: 'rejected', error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
      continue;
    }
    try {
      results.push(await recordSale(cashier, cashierName, deviceId, parsed.data));
    } catch (error) {
      // Only a problem with the sale itself refuses it. A database or server fault
      // fails the whole request, so the till keeps the sale queued and retries.
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      results.push({ id: parsed.data.id, status: 'rejected', error: error.message });
    }
  }
  return { results, syncedAt: new Date().toISOString() };
}

async function recordSale(cashier: Cashier, cashierName: string, deviceId: string, input: SaleInput): Promise<SyncResult> {
  const { pharmacyId } = cashier;
  const existing = await findSale(input.id);
  if (existing) {
    if (existing.pharmacyId !== pharmacyId) throw badRequest('This sale id is already in use');
    return { id: input.id, status: 'duplicate', sale: await getSale(pharmacyId, input.id) };
  }
  if (input.saleDiscount > 0 && !isManagerRole(cashier.role)) throw badRequest('Only a manager can discount a whole sale');
  const soldAt = new Date(input.soldAt);
  if (soldAt.getTime() > Date.now() + 10 * 60_000) throw badRequest('The sale time is in the future; check the till clock');

  const priced = priceSale(input.items, input.saleDiscount);
  if (Math.abs(priced.total - input.total) > 0.009) {
    throw badRequest(`Sale total ${input.total} does not match its items (${priced.total})`);
  }
  const amountTendered = round2(input.payments.reduce((sum, payment) => sum + payment.amount, 0));
  if (amountTendered + 0.009 < priced.total) throw badRequest('The payments do not cover the sale total');
  const changeDue = round2(amountTendered - priced.total);
  const cashPaid = input.payments.filter((payment) => payment.method === 'cash').reduce((sum, payment) => sum + payment.amount, 0);
  if (changeDue > cashPaid + 0.009) throw badRequest('Only cash payments can be given change');

  const productIds = [...new Set(input.items.map((item) => item.productId).filter((value): value is string => Boolean(value)))];

  try {
    await db.transaction(async (tx) => {
      const rows = productIds.length
        ? await tx
          .select({ id: products.id, pharmacyId: products.pharmacyId, stockRemaining: products.stockRemaining, purchasePrice: products.purchasePrice })
          .from(products)
          .where(inArray(products.id, productIds))
          .for('update')
        : [];
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.some((row) => row.pharmacyId !== pharmacyId)) throw badRequest('A product on this sale belongs to another pharmacy');

      const warnings: PosStockWarning[] = [];
      const remaining = new Map(rows.map((row) => [row.id, row.stockRemaining]));
      const movements: Array<typeof inventoryMovements.$inferInsert> = [];
      for (const item of input.items) {
        if (!item.productId || !byId.has(item.productId)) continue;
        const available = remaining.get(item.productId) ?? 0;
        const taken = Math.min(available, item.quantity);
        // The goods already left the counter; record the shortfall rather than refuse the sale.
        if (taken < item.quantity) warnings.push({ productId: item.productId, name: item.name, requested: item.quantity, available });
        remaining.set(item.productId, available - taken);
        if (taken > 0) movements.push({ id: newId(), pharmacyId, productId: item.productId, quantity: -taken, reason: `Sold · receipt ${input.receiptNumber}` });
      }

      await tx.insert(posSales).values({
        id: input.id,
        pharmacyId,
        receiptNumber: input.receiptNumber,
        deviceId,
        cashierStaffId: cashier.staffId ?? null,
        cashierName,
        customerName: input.customerName || null,
        customerPhone: input.customerPhone || null,
        subtotal: priced.subtotal,
        discountTotal: priced.discountTotal,
        total: priced.total,
        payments: input.payments.map((payment): PosPayment => ({ method: payment.method, amount: round2(payment.amount), reference: payment.reference ?? null })),
        amountTendered,
        changeDue,
        notes: input.notes || null,
        stockWarnings: warnings.length ? warnings : null,
        soldAt,
      });
      await tx.insert(posSaleItems).values(input.items.map((item, index) => ({
        id: newId(),
        saleId: input.id,
        productId: item.productId && byId.has(item.productId) ? item.productId : null,
        name: item.name,
        sku: item.sku ?? null,
        batchNumber: item.batchNumber ?? null,
        unitPrice: item.unitPrice,
        discount: item.discount,
        quantity: item.quantity,
        lineTotal: priced.lines[index]!.lineTotal,
        unitCost: item.productId ? byId.get(item.productId)?.purchasePrice ?? null : null,
      })));
      for (const [productId, stockRemaining] of remaining) {
        if (stockRemaining !== byId.get(productId)?.stockRemaining) await tx.update(products).set({ stockRemaining }).where(eq(products.id, productId));
      }
      if (movements.length) await tx.insert(inventoryMovements).values(movements);
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Either a concurrent retry of this sale won the race, or the receipt number is taken.
    const raced = await findSale(input.id);
    if (raced?.pharmacyId === pharmacyId) return { id: input.id, status: 'duplicate', sale: await getSale(pharmacyId, input.id) };
    throw badRequest(`Receipt number ${input.receiptNumber} is already used by another sale`);
  }
  return { id: input.id, status: 'synced', sale: await getSale(pharmacyId, input.id) };
}

async function findSale(id: string) {
  const [sale] = await db.select({ pharmacyId: posSales.pharmacyId }).from(posSales).where(eq(posSales.id, id)).limit(1);
  return sale;
}

export async function getSale(pharmacyId: string, id: string, includeCosts = true) {
  const [sale] = await db.select().from(posSales).where(and(eq(posSales.id, id), eq(posSales.pharmacyId, pharmacyId))).limit(1);
  if (!sale) throw notFound('Sale');
  const items = await db.select().from(posSaleItems).where(eq(posSaleItems.saleId, id));
  return { ...sale, items: includeCosts ? items : items.map((item) => ({ ...item, unitCost: null })) };
}

type ListInput = { from?: string; to?: string; search?: string; status?: 'completed' | 'voided'; limit: number; offset: number };

/** Managers see every sale; other staff see only the sales they rang up. */
export async function listSales(cashier: Cashier, query: ListInput) {
  const term = query.search ? `%${query.search}%` : undefined;
  const where = and(
    eq(posSales.pharmacyId, cashier.pharmacyId),
    isManagerRole(cashier.role) ? undefined : cashier.staffId ? eq(posSales.cashierStaffId, cashier.staffId) : undefined,
    query.from ? gte(posSales.soldAt, new Date(query.from)) : undefined,
    query.to ? lt(posSales.soldAt, new Date(query.to)) : undefined,
    query.status ? eq(posSales.status, query.status) : undefined,
    term ? or(like(posSales.receiptNumber, term), like(posSales.customerName, term), like(posSales.customerPhone, term)) : undefined,
  );
  const [sales, [total]] = await Promise.all([
    db.select().from(posSales).where(where).orderBy(desc(posSales.soldAt)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(posSales).where(where),
  ]);
  const items = sales.length ? await db.select().from(posSaleItems).where(inArray(posSaleItems.saleId, sales.map((sale) => sale.id))) : [];
  const includeCosts = isManagerRole(cashier.role);
  return {
    items: sales.map((sale) => ({
      ...sale,
      items: items.filter((item) => item.saleId === sale.id).map((item) => includeCosts ? item : { ...item, unitCost: null }),
    })),
    total: total?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** Cancels a sale and puts its stock back on the shelf. */
export async function voidSale(pharmacyId: string, id: string, reason: string, voidedByName: string) {
  const sale = await getSale(pharmacyId, id);
  if (sale.status === 'voided') throw badRequest('This sale is already voided');
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: posSales.status }).from(posSales).where(eq(posSales.id, id)).for('update');
    if (locked?.status !== 'completed') throw badRequest('This sale is already voided');
    // Only return what the sale actually took off the shelf.
    const taken = await tx
      .select({ productId: inventoryMovements.productId, quantity: inventoryMovements.quantity })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.pharmacyId, pharmacyId), eq(inventoryMovements.reason, `Sold · receipt ${sale.receiptNumber}`)));
    for (const movement of taken) {
      const [product] = await tx.select({ stockRemaining: products.stockRemaining }).from(products).where(eq(products.id, movement.productId)).for('update');
      if (!product) continue;
      await tx.update(products).set({ stockRemaining: product.stockRemaining - movement.quantity }).where(eq(products.id, movement.productId));
      await tx.insert(inventoryMovements).values({ id: newId(), pharmacyId, productId: movement.productId, quantity: -movement.quantity, reason: `Voided receipt ${sale.receiptNumber}` });
    }
    await tx.update(posSales).set({ status: 'voided', voidReason: reason, voidedByName, voidedAt: new Date() }).where(eq(posSales.id, id));
  });
  return getSale(pharmacyId, id);
}

/** End-of-day style totals for a time window (the till sends its local day bounds). */
export async function summary(pharmacyId: string, from: string, to: string) {
  const window = and(eq(posSales.pharmacyId, pharmacyId), gte(posSales.soldAt, new Date(from)), lt(posSales.soldAt, new Date(to)));
  const sales = await db.select().from(posSales).where(window).limit(50_000);
  const completed = sales.filter((sale) => sale.status === 'completed');
  const voided = sales.filter((sale) => sale.status === 'voided');
  const lines = completed.length
    ? await db.select().from(posSaleItems).where(inArray(posSaleItems.saleId, completed.map((sale) => sale.id)))
    : [];

  const byMethod = new Map<string, number>();
  for (const sale of completed) {
    // Change is handed back in cash, so it comes off the cash takings.
    let change = sale.changeDue;
    for (const payment of sale.payments) {
      let amount = payment.amount;
      if (payment.method === 'cash' && change > 0) {
        const back = Math.min(change, amount);
        amount -= back;
        change -= back;
      }
      byMethod.set(payment.method, round2((byMethod.get(payment.method) ?? 0) + amount));
    }
  }
  const byCashier = new Map<string, { name: string; sales: number; total: number }>();
  for (const sale of completed) {
    const key = sale.cashierStaffId ?? 'owner';
    const entry = byCashier.get(key) ?? { name: sale.cashierName, sales: 0, total: 0 };
    entry.sales += 1;
    entry.total = round2(entry.total + sale.total);
    byCashier.set(key, entry);
  }
  const byProduct = new Map<string, { name: string; quantity: number; revenue: number }>();
  let cost = 0;
  let costKnown = true;
  for (const line of lines) {
    const key = line.productId ?? line.name;
    const entry = byProduct.get(key) ?? { name: line.name, quantity: 0, revenue: 0 };
    entry.quantity += line.quantity;
    entry.revenue = round2(entry.revenue + line.lineTotal);
    byProduct.set(key, entry);
    if (line.unitCost === null) costKnown = false;
    else cost += line.unitCost * line.quantity;
  }
  const net = round2(completed.reduce((sum, sale) => sum + sale.total, 0));
  return {
    from,
    to,
    salesCount: completed.length,
    itemsSold: lines.reduce((sum, line) => sum + line.quantity, 0),
    gross: round2(completed.reduce((sum, sale) => sum + sale.subtotal, 0)),
    discounts: round2(completed.reduce((sum, sale) => sum + sale.discountTotal, 0)),
    net,
    averageSale: completed.length ? round2(net / completed.length) : 0,
    costOfGoods: round2(cost),
    grossProfit: round2(net - cost),
    /** False when some lines had no purchase cost, so profit is an upper bound. */
    costComplete: costKnown,
    voidedCount: voided.length,
    voidedTotal: round2(voided.reduce((sum, sale) => sum + sale.total, 0)),
    payments: [...byMethod].map(([method, amount]) => ({ method, amount })),
    cashiers: [...byCashier.values()].sort((a, b) => b.total - a.total),
    topProducts: [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    stockWarnings: completed.flatMap((sale) => (sale.stockWarnings ?? []).map((warning) => ({ ...warning, receiptNumber: sale.receiptNumber }))),
  };
}
