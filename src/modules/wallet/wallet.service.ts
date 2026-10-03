import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, walletTransactions } from '../../db/schema/index.js';
import { sendPush } from '../../integrations/push.js';
import { isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Pagination } from '../../lib/pagination.js';
import { createNotification } from '../notifications/notifications.service.js';
import { runEffects, type Effect } from '../payments/effects.js';
import { credit, debit, WALLET_CURRENCY } from './wallet.ledger.js';

export async function getWallet(userId: string) {
  const [row] = await db.select({ balance: users.walletBalance }).from(users).where(eq(users.id, userId));
  if (!row) throw notFound('User');
  return { balance: row.balance, currency: WALLET_CURRENCY };
}

export function listTransactions(userId: string, query: Pagination & { type?: 'credit' | 'debit' }) {
  return db
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, userId), query.type ? eq(walletTransactions.type, query.type) : undefined))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(query.limit)
    .offset(query.offset);
}

/**
 * Peer-to-peer transfer by recipient email. Both balances move in one
 * transaction; both rows are locked in id order to avoid deadlocks.
 * Idempotent via UNIQUE(user_id, idempotency_key) on the sender's debit.
 */
export async function transfer(senderId: string, input: { email: string; amount: number }, idempotencyKey?: string) {
  const [recipient] = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, token: users.fcmToken })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (!recipient) throw badRequest('No user found with that email');
  if (recipient.id === senderId) throw badRequest('You cannot send funds to yourself');

  if (idempotencyKey) {
    const done = await findTransfer(senderId, idempotencyKey);
    if (done) return done;
  }

  const fmt = (n: number) => `${WALLET_CURRENCY} ${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  let effects: Effect[] = [];
  try {
    effects = await db.transaction(async (tx) => {
      // Lock both wallets up front, in primary-key order, so opposite transfers can't deadlock.
      const locked = await tx
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(inArray(users.id, [senderId, recipient.id]))
        .orderBy(users.id)
        .for('update');
      const sender = locked.find((r) => r.id === senderId);
      const senderName = `${sender?.firstName ?? ''} ${sender?.lastName ?? ''}`.trim();

      await debit(tx, {
        userId: senderId,
        amount: input.amount,
        title: `You sent ${fmt(input.amount)} to ${recipient.firstName} ${recipient.lastName}`.trim(),
        idempotencyKey,
      });
      await credit(tx, { userId: recipient.id, amount: input.amount, title: `Received ${fmt(input.amount)} from ${senderName}` });
      const notify = await createNotification(
        { userId: recipient.id, type: 'transaction', title: `Credit alert of ${fmt(input.amount)} from ${senderName}` },
        tx,
      );
      return [
        notify,
        () =>
          sendPush([recipient.token], {
            title: 'Credit Alert',
            body: `Incoming transfer of ${fmt(input.amount)} from ${senderName}`,
            data: { type: 'transaction' },
          }),
      ];
    });
  } catch (err) {
    if (idempotencyKey && isDuplicateKeyError(err)) {
      const done = await findTransfer(senderId, idempotencyKey);
      if (done) return done;
    }
    throw err;
  }
  await runEffects(effects);
  return (await findTransfer(senderId, idempotencyKey)) ?? { ...(await getWallet(senderId)) };
}

async function findTransfer(senderId: string, idempotencyKey?: string) {
  if (!idempotencyKey) return null;
  const [tx] = await db
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.userId, senderId), eq(walletTransactions.idempotencyKey, idempotencyKey)))
    .limit(1);
  return tx ? { transaction: tx, balance: tx.balanceAfter, currency: WALLET_CURRENCY } : null;
}
