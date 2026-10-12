import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { appSettings, orders, pharmacies, pharmacyLedger, type PharmacyLedgerType } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';
import { getPayoutSettings } from './payouts.settings.js';

type Entry = {
  pharmacyId: string;
  type: PharmacyLedgerType;
  amount: number;
  description: string;
  orderId?: string | null;
  payoutId?: string | null;
  createdBy?: string | null;
  availableAt?: Date;
};

/**
 * Posts one ledger entry and moves the cached balance with it. Every writer
 * locks the pharmacy row first, so balances and availability checks never race.
 */
export async function post(tx: Tx, entry: Entry) {
  const [row] = await tx.select({ balance: pharmacies.balance }).from(pharmacies).where(eq(pharmacies.id, entry.pharmacyId)).for('update');
  if (!row) throw notFound('Pharmacy');
  const balanceAfter = round2(row.balance + entry.amount);
  await tx.update(pharmacies).set({ balance: balanceAfter }).where(eq(pharmacies.id, entry.pharmacyId));
  await tx.insert(pharmacyLedger).values({
    id: newId(),
    pharmacyId: entry.pharmacyId,
    type: entry.type,
    amount: round2(entry.amount),
    balanceAfter,
    description: entry.description,
    orderId: entry.orderId ?? null,
    payoutId: entry.payoutId ?? null,
    createdBy: entry.createdBy ?? null,
    availableAt: entry.availableAt ?? new Date(),
  });
  return balanceAfter;
}

/** Locks the pharmacy row and returns its balances; use before deciding how much can leave. */
export async function lockBalances(tx: Tx, pharmacyId: string) {
  const [row] = await tx.select({ id: pharmacies.id }).from(pharmacies).where(eq(pharmacies.id, pharmacyId)).for('update');
  if (!row) throw notFound('Pharmacy');
  return balances(pharmacyId, tx);
}

/** `available` can be withdrawn now; `pending` is still in its clearing period. */
export async function balances(pharmacyId: string, executor: Tx | typeof db = db) {
  const [row] = await executor
    .select({
      total: sql<string>`coalesce(sum(${pharmacyLedger.amount}), 0)`,
      available: sql<string>`coalesce(sum(case when ${pharmacyLedger.availableAt} <= utc_timestamp(3) then ${pharmacyLedger.amount} else 0 end), 0)`,
    })
    .from(pharmacyLedger)
    .where(eq(pharmacyLedger.pharmacyId, pharmacyId));
  const total = round2(Number(row?.total ?? 0));
  const available = round2(Number(row?.available ?? 0));
  return { balance: total, available: Math.max(0, available), pending: round2(Math.max(0, total - Math.max(0, available))) };
}

/** What this order has put into the pharmacy's balance so far (earnings less reversals). */
async function orderNet(tx: Tx, orderId: string) {
  const [row] = await tx
    .select({ net: sql<string>`coalesce(sum(${pharmacyLedger.amount}), 0)` })
    .from(pharmacyLedger)
    .where(and(eq(pharmacyLedger.orderId, orderId), inArray(pharmacyLedger.type, ['order_earning', 'order_reversal'])));
  return round2(Number(row?.net ?? 0));
}

/**
 * Makes the ledger agree with the order: a completed order has paid the
 * pharmacy its earning exactly once; any other status has paid nothing.
 * Call it after any status change, inside the same transaction. Idempotent.
 */
export async function settleOrder(tx: Tx, orderId: string) {
  const [order] = await tx
    .select({ id: orders.id, pharmacyId: orders.pharmacyId, status: orders.status, earning: orders.pharmacyEarning, trackingId: orders.trackingId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for('update');
  if (!order) return;
  const net = await orderNet(tx, orderId);
  const owed = order.status === 'completed' ? round2(order.earning ?? 0) : 0;
  if (Math.abs(owed - net) < 0.005) return;
  if (owed > net) {
    const { clearingHours } = await getPayoutSettings(tx);
    await post(tx, {
      pharmacyId: order.pharmacyId,
      type: 'order_earning',
      amount: round2(owed - net),
      description: `Order ${order.trackingId} delivered`,
      orderId,
      availableAt: new Date(Date.now() + clearingHours * 3600_000),
    });
  } else {
    await post(tx, {
      pharmacyId: order.pharmacyId,
      type: 'order_reversal',
      amount: round2(owed - net),
      description: `Order ${order.trackingId} is no longer completed`,
      orderId,
    });
  }
}

const LEDGER_START_KEY = 'pharmacy_ledger_started_at';

/** When earnings tracking began; orders completed before it were settled outside the ledger. */
export async function ledgerStart(): Promise<Date> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LEDGER_START_KEY)).limit(1);
  if (row && typeof row.value === 'string') return new Date(row.value);
  const now = new Date();
  await db.insert(appSettings).values({ key: LEDGER_START_KEY, value: now.toISOString() }).onDuplicateKeyUpdate({ set: { key: LEDGER_START_KEY } });
  return now;
}

/**
 * Safety net for any completion path that forgot to call settleOrder:
 * credits completed orders (since tracking began) that have no earning yet.
 */
export async function sweepUnsettledOrders(limit = 200) {
  const start = await ledgerStart();
  const missing = await db
    .select({ id: orders.id })
    .from(orders)
    .leftJoin(pharmacyLedger, and(eq(pharmacyLedger.orderId, orders.id), eq(pharmacyLedger.type, 'order_earning')))
    .where(and(eq(orders.status, 'completed'), gte(orders.updatedAt, start), isNull(pharmacyLedger.id)))
    .limit(limit);
  for (const { id } of missing) await db.transaction((tx) => settleOrder(tx, id));
  return missing.length;
}
