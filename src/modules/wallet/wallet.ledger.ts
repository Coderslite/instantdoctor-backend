import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { users, walletTransactions } from '../../db/schema/index.js';
import { unprocessable, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';

/** The wallet is denominated in NGN (legacy behaviour of the app). */
export const WALLET_CURRENCY = 'NGN';

interface LedgerEntry {
  userId: string;
  amount: number;
  title: string;
  paymentId?: string | null;
  idempotencyKey?: string | null;
}

async function lockBalance(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ balance: users.walletBalance })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!row) throw notFound('User');
  return row.balance;
}

/** Credits a wallet. Must run inside a transaction; the user row is locked. */
export async function credit(tx: Tx, entry: LedgerEntry) {
  const balance = round2((await lockBalance(tx, entry.userId)) + entry.amount);
  await tx.update(users).set({ walletBalance: balance }).where(eq(users.id, entry.userId));
  await tx.insert(walletTransactions).values({
    id: newId(),
    userId: entry.userId,
    type: 'credit',
    amount: entry.amount,
    currency: WALLET_CURRENCY,
    title: entry.title,
    balanceAfter: balance,
    paymentId: entry.paymentId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
  });
  return balance;
}

/** Debits a wallet, rejecting overdrafts. Must run inside a transaction. */
export async function debit(tx: Tx, entry: LedgerEntry) {
  const current = await lockBalance(tx, entry.userId);
  if (current < entry.amount) throw unprocessable('INSUFFICIENT_FUNDS', 'Insufficient wallet balance');
  const balance = round2(current - entry.amount);
  await tx.update(users).set({ walletBalance: balance }).where(eq(users.id, entry.userId));
  await tx.insert(walletTransactions).values({
    id: newId(),
    userId: entry.userId,
    type: 'debit',
    amount: entry.amount,
    currency: WALLET_CURRENCY,
    title: entry.title,
    balanceAfter: balance,
    paymentId: entry.paymentId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
  });
  return balance;
}

/** Adds to the referral balance (separate from the spendable wallet). */
export async function creditReferralBalance(tx: Tx, userId: string, amount: number) {
  await tx
    .update(users)
    .set({ referralBalance: sql`${users.referralBalance} + ${amount}` })
    .where(eq(users.id, userId));
}
