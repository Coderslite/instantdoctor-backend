import { and, count, desc, eq, gte, inArray, like, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { admins, pharmacies, pharmacyBankAccounts, pharmacyLedger, pharmacyPayoutRuns, pharmacyPayouts, type PayoutStatus } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { ProviderError } from '../../integrations/payments/types.js';
import { getTransferGateway, type TransferResult } from '../../integrations/payments/transfers.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { round2, toMinorUnits } from '../../lib/money.js';
import { balances, lockBalances, post } from './payouts.ledger.js';
import { getPayoutSettings, scheduledSlot } from './payouts.settings.js';

const OPEN: PayoutStatus[] = ['pending_approval', 'processing'];
type Payout = typeof pharmacyPayouts.$inferSelect;

/** Paystack accepts 16–50 lowercase letters, digits, dashes and underscores. */
const transferReference = () => `idpp_${newId().replaceAll('-', '')}`;

const notify = (event: 'requested' | 'scheduled' | 'paid' | 'failed' | 'rejected', payout: Payout, reason?: string | null) => {
  void (async () => {
    const [pharmacy] = await db.select({ name: pharmacies.name, email: pharmacies.email }).from(pharmacies).where(eq(pharmacies.id, payout.pharmacyId)).limit(1);
    if (!pharmacy) return;
    await mailer.pharmacyPayoutUpdate({ to: pharmacy.email, event, pharmacyName: pharmacy.name, amount: payout.amount, reference: payout.reference, bankName: payout.bankName, accountNumber: payout.accountNumber, reason });
  })().catch((err: unknown) => logger.error({ err, payoutId: payout.id, event }, 'Payout email failed'));
};

async function payoutById(id: string) {
  const [payout] = await db.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.id, id)).limit(1);
  if (!payout) throw notFound('Payout');
  return payout;
}

/* ───────────── bank account ───────────── */

export const listBanks = () => getTransferGateway().listBanks();

export async function bankAccount(pharmacyId: string) {
  const [account] = await db.select().from(pharmacyBankAccounts).where(eq(pharmacyBankAccounts.pharmacyId, pharmacyId)).limit(1);
  return account ? { bankCode: account.bankCode, bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName, updatedAt: account.updatedAt } : null;
}

/** Verifies the account with the bank (the name comes from the bank, not the form) and registers it for transfers. */
export async function saveBankAccount(pharmacyId: string, input: { bankCode: string; accountNumber: string }, changedBy: string) {
  const [open] = await db.select({ id: pharmacyPayouts.id }).from(pharmacyPayouts).where(and(eq(pharmacyPayouts.pharmacyId, pharmacyId), inArray(pharmacyPayouts.status, OPEN))).limit(1);
  if (open) throw conflict('PAYOUT_IN_PROGRESS', 'A payout is in progress. Change the bank account after it is paid, or cancel the request first.');
  const gateway = getTransferGateway();
  const bank = (await gateway.listBanks()).find((item) => item.code === input.bankCode);
  if (!bank) throw badRequest('Choose a bank from the list');
  let accountName: string;
  try {
    ({ accountName } = await gateway.resolveAccount(input.accountNumber, input.bankCode));
  } catch (err) {
    if (err instanceof ProviderError && err.httpStatus && err.httpStatus < 500) throw unprocessable('ACCOUNT_NOT_FOUND', 'That account number was not found at this bank. Check both and try again.');
    throw err;
  }
  const { recipientCode } = await gateway.createRecipient({ name: accountName, accountNumber: input.accountNumber, bankCode: input.bankCode });
  const values = { bankCode: bank.code, bankName: bank.name, accountNumber: input.accountNumber, accountName, recipientCode, updatedBy: changedBy };
  await db.insert(pharmacyBankAccounts).values({ pharmacyId, ...values }).onDuplicateKeyUpdate({ set: values });
  // A changed payout account is the first thing a fraudster does: always tell the owner.
  const [pharmacy] = await db.select({ name: pharmacies.name, email: pharmacies.email }).from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
  if (pharmacy) void mailer.pharmacyBankAccountChanged({ to: pharmacy.email, pharmacyName: pharmacy.name, bankName: bank.name, accountNumber: input.accountNumber, accountName, changedBy, at: new Date() }).catch((err: unknown) => logger.error({ err, pharmacyId }, 'Bank change email failed'));
  return bankAccount(pharmacyId);
}

/* ───────────── pharmacy side ───────────── */

export async function summary(pharmacyId: string) {
  const settings = await getPayoutSettings();
  const [money, account, [paid], [open]] = await Promise.all([
    balances(pharmacyId),
    bankAccount(pharmacyId),
    db.select({ total: sql<string>`coalesce(sum(${pharmacyPayouts.amount}), 0)` }).from(pharmacyPayouts).where(and(eq(pharmacyPayouts.pharmacyId, pharmacyId), eq(pharmacyPayouts.status, 'paid'))),
    db.select().from(pharmacyPayouts).where(and(eq(pharmacyPayouts.pharmacyId, pharmacyId), inArray(pharmacyPayouts.status, OPEN))).orderBy(desc(pharmacyPayouts.createdAt)).limit(1),
  ]);
  const slot = scheduledSlot(settings);
  return {
    ...money,
    currency: 'NGN',
    totalPaidOut: round2(Number(paid?.total ?? 0)),
    openPayout: open ?? null,
    bankAccount: account,
    clearingHours: settings.clearingHours,
    nextWeeklyPayoutAt: settings.weeklyEnabled ? slot.next.toISOString() : null,
  };
}

export async function listPayouts(pharmacyId: string | null, query: { status?: PayoutStatus; search?: string; limit: number; offset: number }) {
  const term = query.search ? `%${query.search}%` : undefined;
  const where = and(
    pharmacyId ? eq(pharmacyPayouts.pharmacyId, pharmacyId) : undefined,
    query.status ? eq(pharmacyPayouts.status, query.status) : undefined,
    term ? or(like(pharmacyPayouts.reference, term), like(pharmacies.name, term), like(pharmacyPayouts.accountName, term)) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db.select({ payout: pharmacyPayouts, pharmacyName: pharmacies.name }).from(pharmacyPayouts).innerJoin(pharmacies, eq(pharmacies.id, pharmacyPayouts.pharmacyId)).where(where).orderBy(desc(pharmacyPayouts.createdAt)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(pharmacyPayouts).innerJoin(pharmacies, eq(pharmacies.id, pharmacyPayouts.pharmacyId)).where(where),
  ]);
  return { items: items.map(({ payout, pharmacyName }) => ({ ...payout, pharmacyName })), total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function ledger(pharmacyId: string, query: { limit: number; offset: number }) {
  const where = eq(pharmacyLedger.pharmacyId, pharmacyId);
  const [items, [total]] = await Promise.all([
    db.select().from(pharmacyLedger).where(where).orderBy(desc(pharmacyLedger.createdAt), desc(pharmacyLedger.id)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(pharmacyLedger).where(where),
  ]);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

/**
 * Reserves the money straight away (a ledger debit) so it can't be withdrawn
 * twice, then waits for an admin. One open payout per pharmacy at a time.
 */
export async function requestPayout(pharmacyId: string, input: { amount: number; trigger?: 'on_demand' | 'scheduled'; requestedBy: string; runId?: string | null }) {
  const trigger = input.trigger ?? 'on_demand';
  const amount = round2(input.amount);
  const payout = await db.transaction(async (tx) => {
    const { available } = await lockBalances(tx, pharmacyId);
    const [open] = await tx.select({ id: pharmacyPayouts.id }).from(pharmacyPayouts).where(and(eq(pharmacyPayouts.pharmacyId, pharmacyId), inArray(pharmacyPayouts.status, OPEN))).limit(1);
    if (open) throw conflict('PAYOUT_IN_PROGRESS', 'You already have a payout in progress. Wait for it to be paid, or cancel it first.');
    const [account] = await tx.select().from(pharmacyBankAccounts).where(eq(pharmacyBankAccounts.pharmacyId, pharmacyId)).limit(1);
    if (!account) throw unprocessable('NO_BANK_ACCOUNT', 'Add the bank account payouts should go to first.');
    if (amount <= 0) throw badRequest('Enter an amount to withdraw');
    if (amount > available + 0.001) throw unprocessable('INSUFFICIENT_BALANCE', `You can withdraw up to ₦${available.toLocaleString('en-NG')} now. Newer earnings become available after the clearing period.`);
    const row: typeof pharmacyPayouts.$inferInsert = {
      id: newId(), pharmacyId, reference: transferReference(), amount, trigger, status: 'pending_approval',
      bankName: account.bankName, accountNumber: account.accountNumber, accountName: account.accountName, recipientCode: account.recipientCode,
      requestedBy: input.requestedBy, runId: input.runId ?? null,
    };
    await tx.insert(pharmacyPayouts).values(row);
    await post(tx, { pharmacyId, type: 'payout', amount: -amount, description: trigger === 'scheduled' ? 'Weekly payout' : 'Withdrawal request', payoutId: row.id, createdBy: input.requestedBy });
    return row;
  });
  const saved = await payoutById(payout.id!);
  notify(trigger === 'scheduled' ? 'scheduled' : 'requested', saved);
  if (trigger === 'on_demand') {
    const [pharmacy] = await db.select({ name: pharmacies.name }).from(pharmacies).where(eq(pharmacies.id, pharmacyId)).limit(1);
    void mailer.opsPayoutRequested({ pharmacyName: pharmacy?.name ?? 'A pharmacy', amount, reference: saved.reference, trigger }).catch((err: unknown) => logger.error({ err }, 'Ops payout email failed'));
  }
  return saved;
}

/** Puts reserved money back when a payout won't happen. Runs once per payout. */
async function release(payoutId: string, status: 'failed' | 'rejected' | 'cancelled', detail: { reason?: string | null; by?: string | null; from: PayoutStatus[] }) {
  return db.transaction(async (tx) => {
    const [payout] = await tx.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.id, payoutId)).for('update');
    if (!payout) throw notFound('Payout');
    if (!detail.from.includes(payout.status)) return null;
    await tx.update(pharmacyPayouts).set({
      status,
      ...(status === 'rejected' ? { rejectionReason: detail.reason ?? null } : {}),
      ...(status === 'failed' ? { lastError: detail.reason?.slice(0, 500) ?? null } : {}),
    }).where(eq(pharmacyPayouts.id, payoutId));
    await post(tx, { pharmacyId: payout.pharmacyId, type: 'payout_reversal', amount: payout.amount, description: status === 'failed' ? 'Payout failed, returned to balance' : status === 'rejected' ? 'Withdrawal declined, returned to balance' : 'Withdrawal cancelled', payoutId, createdBy: detail.by ?? null });
    return { ...payout, status };
  });
}

export async function cancelPayout(pharmacyId: string, payoutId: string, by: string) {
  const payout = await payoutById(payoutId);
  if (payout.pharmacyId !== pharmacyId) throw notFound('Payout');
  const done = await release(payoutId, 'cancelled', { by, from: ['pending_approval'] });
  if (!done) throw badRequest('Only a payout waiting for approval can be cancelled');
  return payoutById(payoutId);
}

/* ───────────── admin side ───────────── */

/** Applies what the transfer provider says happened. Safe to call repeatedly. */
async function applyTransfer(payout: Payout, result: TransferResult) {
  if (result.status === 'success') {
    const updated = await db.update(pharmacyPayouts).set({ status: 'paid', paidAt: new Date(), lastError: null, transferCode: result.transferCode ?? payout.transferCode }).where(and(eq(pharmacyPayouts.id, payout.id), eq(pharmacyPayouts.status, 'processing')));
    if (affectedRows(updated)) notify('paid', await payoutById(payout.id));
    return;
  }
  if (result.status === 'failed' || result.status === 'reversed' || result.status === 'otp') {
    const reason = result.status === 'otp'
      ? 'Paystack asked for an OTP. Turn off "Confirm transfers before sending" (OTP) in Paystack settings so the API can send payouts.'
      : result.reason || (result.status === 'reversed' ? 'The bank reversed the transfer' : 'The bank transfer failed');
    const released = await release(payout.id, 'failed', { reason, from: ['processing'] });
    if (released) notify('failed', { ...payout, status: 'failed' }, reason);
    return;
  }
  if (result.transferCode && result.transferCode !== payout.transferCode) {
    await db.update(pharmacyPayouts).set({ transferCode: result.transferCode }).where(eq(pharmacyPayouts.id, payout.id));
  }
}

/**
 * Approval sends the money. A clear refusal from Paystack (e.g. its balance is
 * too low) puts the payout back in the approval queue with the reason; no answer
 * at all leaves it processing, to be settled by webhook or reconciliation.
 */
export async function approvePayout(payoutId: string, adminName: string) {
  const claimed = await db.update(pharmacyPayouts).set({ status: 'processing', approvedBy: adminName, approvedAt: new Date(), lastError: null }).where(and(eq(pharmacyPayouts.id, payoutId), eq(pharmacyPayouts.status, 'pending_approval')));
  if (!affectedRows(claimed)) {
    const current = await payoutById(payoutId);
    throw badRequest(`This payout is already ${current.status.replace('_', ' ')}`);
  }
  const payout = await payoutById(payoutId);
  let result: TransferResult;
  try {
    result = await getTransferGateway().initiate({ amountMinor: toMinorUnits(payout.amount, 'NGN'), recipientCode: payout.recipientCode, reference: payout.reference, reason: `Instant Doctor payout ${payout.reference}` });
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^\[paystack\]\s*/, '') : 'Transfer failed';
    if (err instanceof ProviderError && err.httpStatus && err.httpStatus < 500 && !/duplicate/i.test(message)) {
      await db.update(pharmacyPayouts).set({ status: 'pending_approval', approvedBy: null, approvedAt: null, lastError: message.slice(0, 500) }).where(eq(pharmacyPayouts.id, payoutId));
      throw unprocessable('TRANSFER_REFUSED', `Paystack refused the transfer: ${message}`);
    }
    // Unknown outcome: never resend blindly. Reconciliation asks Paystack what happened.
    await db.update(pharmacyPayouts).set({ lastError: `Waiting for Paystack: ${message}`.slice(0, 500) }).where(eq(pharmacyPayouts.id, payoutId));
    logger.warn({ err, payoutId }, 'Payout transfer outcome unknown; will reconcile');
    return payoutById(payoutId);
  }
  await applyTransfer(payout, result);
  return payoutById(payoutId);
}

export async function approvePayouts(ids: string[], adminName: string) {
  const results: Array<{ id: string; ok: boolean; status?: PayoutStatus; error?: string }> = [];
  for (const id of ids) {
    try {
      const payout = await approvePayout(id, adminName);
      results.push({ id, ok: payout.status !== 'failed', status: payout.status, error: payout.status === 'failed' ? payout.lastError ?? undefined : undefined });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : 'Failed' });
      // Paystack is out of money: the rest would fail the same way.
      if (err instanceof Error && /balance|insufficient/i.test(err.message)) break;
    }
  }
  return { results };
}

export async function rejectPayout(payoutId: string, reason: string, adminName: string) {
  const released = await release(payoutId, 'rejected', { reason, by: adminName, from: ['pending_approval'] });
  if (!released) throw badRequest('Only a payout waiting for approval can be declined');
  const payout = await payoutById(payoutId);
  notify('rejected', payout, reason);
  return payout;
}

/** Webhook entry point: the event only tells us which payout to look at; Paystack's API says what happened. */
export async function handleTransferEvent(reference: string | null) {
  if (!reference) return;
  const [payout] = await db.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.reference, reference)).limit(1);
  if (!payout || payout.status !== 'processing') return;
  const result = await getTransferGateway().verify(reference);
  if (result) await applyTransfer(payout, result);
}

/** Settles payouts whose webhook never arrived. */
export async function reconcilePayouts() {
  const stale = await db.select().from(pharmacyPayouts).where(and(eq(pharmacyPayouts.status, 'processing'), lt(pharmacyPayouts.updatedAt, new Date(Date.now() - 2 * 60_000)))).limit(50);
  let settled = 0;
  for (const payout of stale) {
    try {
      const result = await getTransferGateway().verify(payout.reference);
      if (result) { await applyTransfer(payout, result); settled += 1; continue; }
      // Paystack never received it (the request died on the way): safe to send again after review.
      if (payout.approvedAt && payout.approvedAt.getTime() < Date.now() - 15 * 60_000) {
        await db.update(pharmacyPayouts).set({ status: 'pending_approval', approvedBy: null, approvedAt: null, lastError: 'The transfer never reached Paystack. Approve it again to send.' }).where(and(eq(pharmacyPayouts.id, payout.id), eq(pharmacyPayouts.status, 'processing')));
        settled += 1;
      }
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, 'Payout reconciliation failed');
    }
  }
  return settled;
}

/**
 * The weekly payout: every pharmacy with money available, a bank account and
 * no payout already in progress gets one. Runs at most once per scheduled slot.
 */
export async function runWeeklyPayouts(options: { now?: Date; manual?: string } = {}) {
  const settings = await getPayoutSettings();
  const now = options.now ?? new Date();
  const slot = scheduledSlot(settings, now);
  if (!options.manual) {
    if (!settings.weeklyEnabled) return null;
    // Moving the weekday must not trigger a second run in the same week.
    const [recent] = await db.select({ id: pharmacyPayoutRuns.id }).from(pharmacyPayoutRuns).where(and(like(pharmacyPayoutRuns.runKey, 'weekly:%'), gte(pharmacyPayoutRuns.createdAt, new Date(now.getTime() - 6 * 86_400_000)))).limit(1);
    if (recent) return null;
  }
  const runId = newId();
  try {
    await db.insert(pharmacyPayoutRuns).values({ id: runId, runKey: options.manual ? `manual:${now.toISOString()}` : slot.key, startedBy: options.manual ?? 'Weekly schedule' });
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }

  const candidates = await db
    .select({ id: pharmacies.id })
    .from(pharmacies)
    .innerJoin(pharmacyBankAccounts, eq(pharmacyBankAccounts.pharmacyId, pharmacies.id))
    .where(and(ne(pharmacies.status, 'deleted'), sql`${pharmacies.balance} > 0`));
  const created: Payout[] = [];
  for (const { id } of candidates) {
    try {
      const { available } = await balances(id);
      if (available <= 0) continue;
      created.push(await requestPayout(id, { amount: available, trigger: 'scheduled', requestedBy: options.manual ?? 'Weekly payout', runId }));
    } catch (err) {
      // An open payout or a race with a withdrawal: skip this pharmacy this week.
      if (!(err instanceof Error && /in progress|INSUFFICIENT/i.test(err.message))) logger.error({ err, pharmacyId: id }, 'Weekly payout failed for pharmacy');
    }
  }
  const total = round2(created.reduce((sum, payout) => sum + payout.amount, 0));
  await db.update(pharmacyPayoutRuns).set({ payoutCount: created.length, totalAmount: total, completedAt: new Date() }).where(eq(pharmacyPayoutRuns.id, runId));
  if (created.length) {
    if (settings.autoApproveScheduled) await approvePayouts(created.map((payout) => payout.id), 'Weekly schedule (auto-approved)');
    else void mailer.opsPayoutRequested({ pharmacyName: '', amount: total, reference: runId, trigger: 'scheduled', count: created.length }).catch((err: unknown) => logger.error({ err }, 'Ops payout email failed'));
  }
  return { runId, payoutCount: created.length, totalAmount: total };
}

export async function adminOverview() {
  const settings = await getPayoutSettings();
  const [byStatus, [owed], runs] = await Promise.all([
    db.select({ status: pharmacyPayouts.status, count: count(), total: sql<string>`coalesce(sum(${pharmacyPayouts.amount}), 0)` }).from(pharmacyPayouts).groupBy(pharmacyPayouts.status),
    db.select({ total: sql<string>`coalesce(sum(${pharmacies.balance}), 0)` }).from(pharmacies),
    db.select().from(pharmacyPayoutRuns).orderBy(desc(pharmacyPayoutRuns.createdAt)).limit(5),
  ]);
  const stat = (status: PayoutStatus) => { const row = byStatus.find((item) => item.status === status); return { count: row?.count ?? 0, total: round2(Number(row?.total ?? 0)) }; };
  const slot = scheduledSlot(settings);
  return {
    pendingApproval: stat('pending_approval'), processing: stat('processing'), paid: stat('paid'), failed: stat('failed'),
    owedToPharmacies: round2(Number(owed?.total ?? 0)),
    nextWeeklyRunAt: settings.weeklyEnabled ? slot.next.toISOString() : null,
    recentRuns: runs,
    settings,
  };
}

/** What each pharmacy is owed right now, largest first. */
export async function pharmacyBalances(query: { search?: string; limit: number; offset: number }) {
  const term = query.search ? `%${query.search}%` : undefined;
  const where = and(ne(pharmacies.status, 'deleted'), term ? like(pharmacies.name, term) : undefined, sql`(${pharmacies.balance} <> 0 or exists (select 1 from pharmacy_ledger l where l.pharmacy_id = ${pharmacies.id}))`);
  const [rows, [total]] = await Promise.all([
    db.select({ id: pharmacies.id, name: pharmacies.name, email: pharmacies.email, balance: pharmacies.balance, bankName: pharmacyBankAccounts.bankName, accountNumber: pharmacyBankAccounts.accountNumber, accountName: pharmacyBankAccounts.accountName, bankUpdatedAt: pharmacyBankAccounts.updatedAt })
      .from(pharmacies).leftJoin(pharmacyBankAccounts, eq(pharmacyBankAccounts.pharmacyId, pharmacies.id)).where(where).orderBy(desc(pharmacies.balance)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(pharmacies).where(where),
  ]);
  const items = await Promise.all(rows.map(async (row) => ({ ...row, ...(await balances(row.id)) })));
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

/** Manual correction by an admin (e.g. settling earnings from before the ledger existed). */
export async function adjustBalance(pharmacyId: string, input: { amount: number; reason: string }, adminName: string) {
  if (input.amount === 0) throw badRequest('Enter an amount other than zero');
  await db.transaction(async (tx) => {
    const { balance } = await lockBalances(tx, pharmacyId);
    if (input.amount < 0 && balance + input.amount < 0) throw badRequest(`The balance is only ₦${balance.toLocaleString('en-NG')}`);
    await post(tx, { pharmacyId, type: 'adjustment', amount: round2(input.amount), description: input.reason, createdBy: adminName });
  });
  return balances(pharmacyId);
}

export async function gatewayBalance() {
  return getTransferGateway().balance();
}

/** "Name (email)" of the admin acting, for the audit trail on each payout. */
export async function adminDisplayName(adminId: string) {
  const [admin] = await db.select({ name: admins.name, email: admins.email }).from(admins).where(eq(admins.id, adminId)).limit(1);
  return admin ? `${admin.name} (${admin.email})` : 'Admin';
}
