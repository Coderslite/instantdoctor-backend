import { and, count, desc, eq, gte, inArray, like, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  doctorLedger,
  doctorPayoutRuns,
  doctorPayouts,
  payoutAccounts,
  users,
  type PayoutStatus,
} from '../../db/schema/index.js';
import { usdRate } from '../../integrations/exchange-rates.js';
import { mailer } from '../../integrations/mailer.js';
import { ProviderError } from '../../integrations/payments/types.js';
import { getTransferGateway, type TransferResult } from '../../integrations/payments/transfers.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { round2, toMinorUnits } from '../../lib/money.js';
import { scheduledSlot } from '../payouts/payouts.settings.js';
import { balanceIn, balances, lockDoctor, post } from './doctor-payouts.ledger.js';
import { getDoctorPayoutSettings } from './doctor-payouts.settings.js';

/**
 * Paying doctors, on the same model as pharmacy payouts: earnings clear, then
 * each week (or on request) the available balance becomes a payout that an
 * admin approves. Naira payouts to a verified Nigerian account are sent by
 * Paystack transfer; anything else (e.g. a doctor abroad) is paid outside the
 * app and recorded by the admin. Money is reserved in the ledger the moment
 * a payout is created, so it can never be paid twice.
 */

const OPEN: PayoutStatus[] = ['pending_approval', 'processing'];
type Payout = typeof doctorPayouts.$inferSelect;

/** Paystack accepts 16–50 lowercase letters, digits, dashes and underscores. */
const transferReference = () => `iddp_${newId().replaceAll('-', '')}`;

const formatAmount = (amount: number, currency: string) => `${currency} ${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

async function doctorContact(doctorId: string) {
  const [doctor] = await db
    .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, doctorId))
    .limit(1);
  return doctor ? { email: doctor.email, name: `${doctor.firstName} ${doctor.lastName}`.trim() } : null;
}

const notify = (event: 'requested' | 'scheduled' | 'paid' | 'failed' | 'rejected', payout: Payout, reason?: string | null) => {
  void (async () => {
    const doctor = await doctorContact(payout.doctorId);
    if (!doctor?.email) return;
    await mailer.doctorPayoutUpdate({
      to: doctor.email,
      event,
      doctorName: doctor.name,
      amount: payout.amount,
      currency: payout.currency,
      reference: payout.reference,
      bankName: payout.bankName,
      accountNumber: payout.accountNumber,
      reason,
    });
  })().catch((err: unknown) => logger.error({ err, payoutId: payout.id, event }, 'Doctor payout email failed'));
};

async function payoutById(id: string) {
  const [payout] = await db.select().from(doctorPayouts).where(eq(doctorPayouts.id, id)).limit(1);
  if (!payout) throw notFound('Payout');
  return payout;
}

/* ───────────── bank account ───────────── */

export const listBanks = () => getTransferGateway().listBanks();

export async function bankAccount(doctorId: string) {
  const [a] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, doctorId)).limit(1);
  if (!a?.accountNumber) return null;
  return {
    bankCode: a.bankCode,
    bankName: a.bankName,
    accountNumber: a.accountNumber,
    accountName: a.accountName,
    /** Checked with the bank and set up for automatic transfers. */
    verified: Boolean(a.recipientCode),
    updatedAt: a.updatedAt,
  };
}

async function assertNoOpenPayout(doctorId: string) {
  const [open] = await db
    .select({ id: doctorPayouts.id })
    .from(doctorPayouts)
    .where(and(eq(doctorPayouts.doctorId, doctorId), inArray(doctorPayouts.status, OPEN)))
    .limit(1);
  if (open) throw conflict('PAYOUT_IN_PROGRESS', 'A payout is in progress. Change your bank account after it is paid.');
}

/**
 * A Nigerian account is checked with the bank (the name comes from the bank,
 * not the form) and registered for transfers. An account outside Nigeria is
 * saved as given and paid manually.
 */
export async function saveBankAccount(
  doctorId: string,
  input: { bankCode: string; accountNumber: string } | { bankName: string; accountNumber: string; accountName: string },
) {
  await assertNoOpenPayout(doctorId);
  let values: { bankName: string; bankCode: string | null; accountNumber: string; accountName: string; recipientCode: string | null };
  if ('bankCode' in input) {
    const gateway = getTransferGateway();
    const bank = (await gateway.listBanks()).find((item) => item.code === input.bankCode);
    if (!bank) throw badRequest('Choose a bank from the list');
    let accountName: string;
    try {
      ({ accountName } = await gateway.resolveAccount(input.accountNumber, input.bankCode));
    } catch (err) {
      if (err instanceof ProviderError && err.httpStatus && err.httpStatus < 500)
        throw unprocessable('ACCOUNT_NOT_FOUND', 'That account number was not found at this bank. Check both and try again.');
      throw err;
    }
    const { recipientCode } = await gateway.createRecipient({ name: accountName, accountNumber: input.accountNumber, bankCode: input.bankCode });
    values = { bankName: bank.name, bankCode: bank.code, accountNumber: input.accountNumber, accountName, recipientCode };
  } else {
    values = { bankName: input.bankName, bankCode: null, accountNumber: input.accountNumber, accountName: input.accountName, recipientCode: null };
  }
  await db.insert(payoutAccounts).values({ userId: doctorId, ...values }).onDuplicateKeyUpdate({ set: values });
  // A changed payout account is the first thing a fraudster does: always tell the doctor.
  const doctor = await doctorContact(doctorId);
  if (doctor?.email)
    void mailer
      .doctorBankAccountChanged({ to: doctor.email, doctorName: doctor.name, bankName: values.bankName, accountNumber: values.accountNumber, accountName: values.accountName, at: new Date() })
      .catch((err: unknown) => logger.error({ err, doctorId }, 'Doctor bank change email failed'));
  return bankAccount(doctorId);
}

/* ───────────── doctor side ───────────── */

export async function summary(doctorId: string) {
  const settings = await getDoctorPayoutSettings();
  const [money, account, paid, open] = await Promise.all([
    balances(doctorId),
    bankAccount(doctorId),
    db
      .select({ currency: doctorPayouts.currency, total: sql<string>`coalesce(sum(${doctorPayouts.amount}), 0)` })
      .from(doctorPayouts)
      .where(and(eq(doctorPayouts.doctorId, doctorId), eq(doctorPayouts.status, 'paid')))
      .groupBy(doctorPayouts.currency),
    db
      .select()
      .from(doctorPayouts)
      .where(and(eq(doctorPayouts.doctorId, doctorId), inArray(doctorPayouts.status, OPEN)))
      .orderBy(desc(doctorPayouts.createdAt)),
  ]);
  const [doctor] = await db.select({ currency: users.earningCurrency }).from(users).where(eq(users.id, doctorId));
  const slot = scheduledSlot(settings);
  return {
    /** The doctor's current earning currency; balances may also exist in earlier ones. */
    currency: doctor?.currency ?? 'NGN',
    balances: money,
    totalPaidOut: paid.map((p) => ({ currency: p.currency, amount: round2(Number(p.total)) })),
    openPayouts: open,
    bankAccount: account,
    clearingHour: settings.clearingHour,
    nextWeeklyPayoutAt: settings.weeklyEnabled ? slot.next.toISOString() : null,
  };
}

export async function listPayouts(
  doctorId: string | null,
  query: { status?: PayoutStatus; search?: string; limit: number; offset: number },
) {
  const term = query.search ? `%${query.search}%` : undefined;
  const doctorName = sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`;
  const where = and(
    doctorId ? eq(doctorPayouts.doctorId, doctorId) : undefined,
    query.status ? eq(doctorPayouts.status, query.status) : undefined,
    term ? or(like(doctorPayouts.reference, term), like(doctorName, term), like(doctorPayouts.accountName, term), like(users.email, term)) : undefined,
  );
  const [items, [total]] = await Promise.all([
    db
      .select({ payout: doctorPayouts, doctorName, doctorEmail: users.email })
      .from(doctorPayouts)
      .innerJoin(users, eq(users.id, doctorPayouts.doctorId))
      .where(where)
      .orderBy(desc(doctorPayouts.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(doctorPayouts).innerJoin(users, eq(users.id, doctorPayouts.doctorId)).where(where),
  ]);
  return {
    items: items.map(({ payout, doctorName: name, doctorEmail }) => ({ ...payout, doctorName: name, doctorEmail })),
    total: total?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function ledger(doctorId: string, query: { limit: number; offset: number }) {
  const where = eq(doctorLedger.doctorId, doctorId);
  const [items, [total]] = await Promise.all([
    db.select().from(doctorLedger).where(where).orderBy(desc(doctorLedger.createdAt), desc(doctorLedger.id)).limit(query.limit).offset(query.offset),
    db.select({ value: count() }).from(doctorLedger).where(where),
  ]);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

/** A legacy account entered without a bank code check gets set up for transfers the first time it's needed. */
async function ensureRecipient(doctorId: string, account: typeof payoutAccounts.$inferSelect) {
  if (account.recipientCode || !account.bankCode || !/^\d{10}$/.test(account.accountNumber ?? '')) return account.recipientCode;
  try {
    const gateway = getTransferGateway();
    const { accountName } = await gateway.resolveAccount(account.accountNumber!, account.bankCode);
    const { recipientCode } = await gateway.createRecipient({ name: accountName, accountNumber: account.accountNumber!, bankCode: account.bankCode });
    await db.update(payoutAccounts).set({ recipientCode, accountName }).where(eq(payoutAccounts.userId, doctorId));
    return recipientCode;
  } catch (err) {
    logger.warn({ err, doctorId }, 'Could not set up doctor account for transfers; paying manually');
    return null;
  }
}

/**
 * Reserves the money straight away (a ledger debit) so it can't be withdrawn
 * twice, then waits for an admin. One open payout per doctor and currency.
 */
export async function requestPayout(
  doctorId: string,
  input: { amount: number; currency: string; trigger?: 'on_demand' | 'scheduled'; requestedBy: string; runId?: string | null },
) {
  const trigger = input.trigger ?? 'on_demand';
  const amount = round2(input.amount);
  const currency = input.currency.toUpperCase();
  const [account] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.userId, doctorId)).limit(1);
  if (!account?.accountNumber || !account.accountName || !account.bankName)
    throw unprocessable('NO_BANK_ACCOUNT', 'Add the bank account your earnings should be paid to first.');
  const recipientCode = currency === 'NGN' ? await ensureRecipient(doctorId, account) : null;
  const payout = await db.transaction(async (tx) => {
    await lockDoctor(tx, doctorId);
    const { available } = await balanceIn(doctorId, currency, tx);
    const [open] = await tx
      .select({ id: doctorPayouts.id })
      .from(doctorPayouts)
      .where(and(eq(doctorPayouts.doctorId, doctorId), eq(doctorPayouts.currency, currency), inArray(doctorPayouts.status, OPEN)))
      .limit(1);
    if (open) throw conflict('PAYOUT_IN_PROGRESS', 'You already have a payout in progress. Wait for it to be paid, or cancel it first.');
    if (amount <= 0) throw badRequest('Enter an amount to withdraw');
    if (amount > available + 0.001)
      throw unprocessable('INSUFFICIENT_BALANCE', `You can withdraw up to ${formatAmount(available, currency)} now. Newer earnings become available after the clearing period.`);
    const row: typeof doctorPayouts.$inferInsert = {
      id: newId(),
      doctorId,
      reference: transferReference(),
      amount,
      currency,
      method: recipientCode ? 'paystack' : 'manual',
      trigger,
      status: 'pending_approval',
      bankName: account.bankName!,
      accountNumber: account.accountNumber!,
      accountName: account.accountName!,
      recipientCode,
      requestedBy: input.requestedBy,
      runId: input.runId ?? null,
    };
    await tx.insert(doctorPayouts).values(row);
    await post(tx, {
      doctorId,
      type: 'payout',
      amount: -amount,
      currency,
      description: trigger === 'scheduled' ? 'Weekly payout' : 'Withdrawal request',
      payoutId: row.id,
      createdBy: input.requestedBy,
    });
    return row;
  });
  const saved = await payoutById(payout.id!);
  notify(trigger === 'scheduled' ? 'scheduled' : 'requested', saved);
  if (trigger === 'on_demand') {
    const doctor = await doctorContact(doctorId);
    void mailer
      .opsDoctorPayouts({ count: 1, totals: { [currency]: amount }, doctorName: doctor?.name, trigger })
      .catch((err: unknown) => logger.error({ err }, 'Ops doctor payout email failed'));
  }
  return saved;
}

/** Puts reserved money back when a payout won't happen. Runs once per payout. */
async function release(payoutId: string, status: 'failed' | 'rejected' | 'cancelled', detail: { reason?: string | null; by?: string | null; from: PayoutStatus[] }) {
  return db.transaction(async (tx) => {
    const [payout] = await tx.select().from(doctorPayouts).where(eq(doctorPayouts.id, payoutId)).for('update');
    if (!payout) throw notFound('Payout');
    if (!detail.from.includes(payout.status)) return null;
    await tx
      .update(doctorPayouts)
      .set({
        status,
        ...(status === 'rejected' ? { rejectionReason: detail.reason ?? null } : {}),
        ...(status === 'failed' ? { lastError: detail.reason?.slice(0, 500) ?? null } : {}),
      })
      .where(eq(doctorPayouts.id, payoutId));
    await post(tx, {
      doctorId: payout.doctorId,
      type: 'payout_reversal',
      amount: payout.amount,
      currency: payout.currency,
      description: status === 'failed' ? 'Payout failed, returned to balance' : status === 'rejected' ? 'Withdrawal declined, returned to balance' : 'Withdrawal cancelled',
      payoutId,
      createdBy: detail.by ?? null,
    });
    return { ...payout, status };
  });
}

export async function cancelPayout(doctorId: string, payoutId: string, by: string) {
  const payout = await payoutById(payoutId);
  if (payout.doctorId !== doctorId) throw notFound('Payout');
  const done = await release(payoutId, 'cancelled', { by, from: ['pending_approval'] });
  if (!done) throw badRequest('Only a payout waiting for approval can be cancelled');
  return payoutById(payoutId);
}

/* ───────────── admin side ───────────── */

/** Applies what the transfer provider says happened. Safe to call repeatedly. */
async function applyTransfer(payout: Payout, result: TransferResult) {
  if (result.status === 'success') {
    const updated = await db
      .update(doctorPayouts)
      .set({ status: 'paid', paidAt: new Date(), lastError: null, transferCode: result.transferCode ?? payout.transferCode })
      .where(and(eq(doctorPayouts.id, payout.id), eq(doctorPayouts.status, 'processing')));
    if (affectedRows(updated)) notify('paid', await payoutById(payout.id));
    return;
  }
  if (result.status === 'failed' || result.status === 'reversed' || result.status === 'otp') {
    const reason =
      result.status === 'otp'
        ? 'Paystack asked for an OTP. Turn off "Confirm transfers before sending" (OTP) in Paystack settings so the API can send payouts.'
        : result.reason || (result.status === 'reversed' ? 'The bank reversed the transfer' : 'The bank transfer failed');
    const released = await release(payout.id, 'failed', { reason, from: ['processing'] });
    if (released) notify('failed', { ...payout, status: 'failed' }, reason);
    return;
  }
  if (result.transferCode && result.transferCode !== payout.transferCode) {
    await db.update(doctorPayouts).set({ transferCode: result.transferCode }).where(eq(doctorPayouts.id, payout.id));
  }
}

/**
 * Approval pays the doctor. Paystack payouts are sent now; a clear refusal
 * puts them back in the queue with the reason, and no answer leaves them
 * processing until the webhook or reconciliation settles them. Manual payouts
 * record that the admin has paid them outside the app (with a reference).
 */
export async function approvePayout(payoutId: string, adminName: string, paymentReference?: string | null) {
  const current = await payoutById(payoutId);
  if (current.status !== 'pending_approval') throw badRequest(`This payout is already ${current.status.replace('_', ' ')}`);
  if (current.method === 'manual') {
    if (!paymentReference?.trim())
      throw badRequest('Pay this doctor by bank transfer first, then enter the transfer reference to record it as paid');
    const done = await db
      .update(doctorPayouts)
      .set({ status: 'paid', approvedBy: adminName, approvedAt: new Date(), paidAt: new Date(), paymentReference: paymentReference.trim(), lastError: null })
      .where(and(eq(doctorPayouts.id, payoutId), eq(doctorPayouts.status, 'pending_approval')));
    if (!affectedRows(done)) throw badRequest('This payout changed; refresh and try again');
    const paid = await payoutById(payoutId);
    notify('paid', paid);
    return paid;
  }
  const claimed = await db
    .update(doctorPayouts)
    .set({ status: 'processing', approvedBy: adminName, approvedAt: new Date(), lastError: null })
    .where(and(eq(doctorPayouts.id, payoutId), eq(doctorPayouts.status, 'pending_approval')));
  if (!affectedRows(claimed)) throw badRequest('This payout changed; refresh and try again');
  const payout = await payoutById(payoutId);
  let result: TransferResult;
  try {
    result = await getTransferGateway().initiate({
      amountMinor: toMinorUnits(payout.amount, 'NGN'),
      recipientCode: payout.recipientCode!,
      reference: payout.reference,
      reason: `Instant Doctor earnings ${payout.reference}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^\[paystack\]\s*/, '') : 'Transfer failed';
    if (err instanceof ProviderError && err.httpStatus && err.httpStatus < 500 && !/duplicate/i.test(message)) {
      await db
        .update(doctorPayouts)
        .set({ status: 'pending_approval', approvedBy: null, approvedAt: null, lastError: message.slice(0, 500) })
        .where(eq(doctorPayouts.id, payoutId));
      throw unprocessable('TRANSFER_REFUSED', `Paystack refused the transfer: ${message}`);
    }
    // Unknown outcome: never resend blindly. Reconciliation asks Paystack what happened.
    await db.update(doctorPayouts).set({ lastError: `Waiting for Paystack: ${message}`.slice(0, 500) }).where(eq(doctorPayouts.id, payoutId));
    logger.warn({ err, payoutId }, 'Doctor payout transfer outcome unknown; will reconcile');
    return payoutById(payoutId);
  }
  await applyTransfer(payout, result);
  return payoutById(payoutId);
}

/** Sends the selected Paystack payouts; manual ones need a reference each and are skipped. */
export async function approvePayouts(ids: string[], adminName: string) {
  const results: Array<{ id: string; ok: boolean; status?: PayoutStatus; error?: string }> = [];
  for (const id of ids) {
    try {
      const payout = await approvePayout(id, adminName);
      results.push({ id, ok: payout.status !== 'failed', status: payout.status, error: payout.status === 'failed' ? (payout.lastError ?? undefined) : undefined });
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

/** Webhook entry point for doctor transfers (references start with iddp_). */
export async function handleTransferEvent(reference: string | null) {
  if (!reference) return false;
  const [payout] = await db.select().from(doctorPayouts).where(eq(doctorPayouts.reference, reference)).limit(1);
  if (!payout) return false;
  if (payout.status !== 'processing') return true;
  const result = await getTransferGateway().verify(reference);
  if (result) await applyTransfer(payout, result);
  return true;
}

/** Settles transfers whose webhook never arrived. */
export async function reconcilePayouts() {
  const stale = await db
    .select()
    .from(doctorPayouts)
    .where(and(eq(doctorPayouts.status, 'processing'), lt(doctorPayouts.updatedAt, new Date(Date.now() - 2 * 60_000))))
    .limit(50);
  let settled = 0;
  for (const payout of stale) {
    try {
      const result = await getTransferGateway().verify(payout.reference);
      if (result) {
        await applyTransfer(payout, result);
        settled += 1;
        continue;
      }
      // Paystack never received it: safe to send again after review.
      if (payout.approvedAt && payout.approvedAt.getTime() < Date.now() - 15 * 60_000) {
        await db
          .update(doctorPayouts)
          .set({ status: 'pending_approval', approvedBy: null, approvedAt: null, lastError: 'The transfer never reached Paystack. Approve it again to send.' })
          .where(and(eq(doctorPayouts.id, payout.id), eq(doctorPayouts.status, 'processing')));
        settled += 1;
      }
    } catch (err) {
      logger.error({ err, payoutId: payout.id }, 'Doctor payout reconciliation failed');
    }
  }
  return settled;
}

/**
 * The weekly payout: every doctor with money available in a currency, a bank
 * account and no payout of that currency in progress gets one. Runs at most
 * once per scheduled slot.
 */
export async function runWeeklyPayouts(options: { now?: Date; manual?: string } = {}) {
  const settings = await getDoctorPayoutSettings();
  const now = options.now ?? new Date();
  const slot = scheduledSlot(settings, now);
  if (!options.manual) {
    if (!settings.weeklyEnabled || now < slot.current) return null;
    // Moving the weekday must not trigger a second run in the same week.
    const [recent] = await db
      .select({ id: doctorPayoutRuns.id })
      .from(doctorPayoutRuns)
      .where(and(like(doctorPayoutRuns.runKey, 'weekly:%'), gte(doctorPayoutRuns.createdAt, new Date(now.getTime() - 6 * 86_400_000))))
      .limit(1);
    if (recent) return null;
  }
  const runId = newId();
  try {
    await db.insert(doctorPayoutRuns).values({ id: runId, runKey: options.manual ? `manual:${now.toISOString()}` : slot.key, startedBy: options.manual ?? 'Weekly schedule' });
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
  const candidates = await db
    .select({ doctorId: doctorLedger.doctorId, currency: doctorLedger.currency })
    .from(doctorLedger)
    .innerJoin(payoutAccounts, eq(payoutAccounts.userId, doctorLedger.doctorId))
    .where(sql`${doctorLedger.availableAt} <= utc_timestamp(3)`)
    .groupBy(doctorLedger.doctorId, doctorLedger.currency)
    .having(sql`sum(${doctorLedger.amount}) > 0`);
  const created: Payout[] = [];
  for (const { doctorId, currency } of candidates) {
    try {
      const { available } = await balanceIn(doctorId, currency);
      if (available <= 0) continue;
      created.push(await requestPayout(doctorId, { amount: available, currency, trigger: 'scheduled', requestedBy: options.manual ?? 'Weekly payout', runId }));
    } catch (err) {
      // An open payout, no bank account or a race with a withdrawal: skip this doctor this week.
      if (!(err instanceof Error && /in progress|INSUFFICIENT|bank account/i.test(err.message)))
        logger.error({ err, doctorId }, 'Weekly payout failed for doctor');
    }
  }
  const totals: Record<string, number> = {};
  for (const p of created) totals[p.currency] = round2((totals[p.currency] ?? 0) + p.amount);
  await db.update(doctorPayoutRuns).set({ payoutCount: created.length, totals, completedAt: new Date() }).where(eq(doctorPayoutRuns.id, runId));
  if (created.length) {
    const automatic = created.filter((p) => p.method === 'paystack');
    if (settings.autoApproveScheduled && automatic.length) await approvePayouts(automatic.map((p) => p.id), 'Weekly schedule (auto-approved)');
    if (!settings.autoApproveScheduled || automatic.length < created.length)
      void mailer
        .opsDoctorPayouts({ count: created.length, totals, trigger: 'scheduled' })
        .catch((err: unknown) => logger.error({ err }, 'Ops doctor payout email failed'));
  }
  return { runId, payoutCount: created.length, totals };
}

/** Mixed-currency totals as one naira figure at today's rates; null when rates are unavailable. */
async function inNaira(totals: Record<string, number>): Promise<number | null> {
  try {
    const ngn = await usdRate('NGN');
    let sum = 0;
    for (const [currency, amount] of Object.entries(totals))
      sum += currency === 'NGN' ? amount : (amount / (await usdRate(currency))) * ngn;
    return round2(sum);
  } catch (err) {
    logger.warn({ err }, 'Could not convert payout totals to naira');
    return null;
  }
}

export async function adminOverview() {
  const settings = await getDoctorPayoutSettings();
  const [byStatus, owed, runs] = await Promise.all([
    db
      .select({ status: doctorPayouts.status, currency: doctorPayouts.currency, count: count(), total: sql<string>`coalesce(sum(${doctorPayouts.amount}), 0)` })
      .from(doctorPayouts)
      .groupBy(doctorPayouts.status, doctorPayouts.currency),
    db
      .select({ currency: doctorLedger.currency, total: sql<string>`coalesce(sum(${doctorLedger.amount}), 0)` })
      .from(doctorLedger)
      .groupBy(doctorLedger.currency),
    db.select().from(doctorPayoutRuns).orderBy(desc(doctorPayoutRuns.createdAt)).limit(5),
  ]);
  const stat = (status: PayoutStatus) => {
    const rows = byStatus.filter((r) => r.status === status);
    return {
      count: rows.reduce((n, r) => n + r.count, 0),
      totals: Object.fromEntries(rows.map((r) => [r.currency, round2(Number(r.total))])),
    };
  };
  const slot = scheduledSlot(settings);
  const pendingApproval = stat('pending_approval');
  const owedToDoctors = Object.fromEntries(owed.map((r) => [r.currency, round2(Number(r.total))]));
  const [pendingNgn, owedNgn] = await Promise.all([inNaira(pendingApproval.totals), inNaira(owedToDoctors)]);
  return {
    pendingApproval: { ...pendingApproval, ngnEquivalent: pendingNgn },
    processing: stat('processing'),
    paid: stat('paid'),
    failed: stat('failed'),
    owedToDoctors,
    /** Everything owed, converted to naira at today's rates (for the headline figure). */
    owedToDoctorsNgn: owedNgn,
    nextWeeklyRunAt: settings.weeklyEnabled ? slot.next.toISOString() : null,
    recentRuns: runs,
    settings,
  };
}

/** What each doctor is owed right now, largest first. */
export async function doctorBalances(query: { search?: string; limit: number; offset: number }) {
  const term = query.search ? `%${query.search}%` : undefined;
  const name = sql<string>`TRIM(CONCAT(${users.firstName}, ' ', ${users.lastName}))`;
  const where = and(eq(users.role, 'doctor'), term ? or(like(name, term), like(users.email, term)) : undefined);
  const rows = await db
    .select({
      id: users.id,
      name,
      email: users.email,
      earningCurrency: users.earningCurrency,
      owed: sql<string>`coalesce(sum(${doctorLedger.amount}), 0)`,
      bankName: payoutAccounts.bankName,
      accountNumber: payoutAccounts.accountNumber,
      accountName: payoutAccounts.accountName,
      verified: sql<boolean>`${payoutAccounts.recipientCode} IS NOT NULL`,
    })
    .from(users)
    .innerJoin(doctorLedger, eq(doctorLedger.doctorId, users.id))
    .leftJoin(payoutAccounts, eq(payoutAccounts.userId, users.id))
    .where(where)
    .groupBy(users.id, payoutAccounts.userId)
    .orderBy(desc(sql`coalesce(sum(${doctorLedger.amount}), 0)`))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db
    .select({ value: sql<number>`count(distinct ${users.id})` })
    .from(users)
    .innerJoin(doctorLedger, eq(doctorLedger.doctorId, users.id))
    .where(where);
  const items = await Promise.all(
    rows.map(async ({ owed: _owed, ...row }) => ({ ...row, verified: Boolean(row.verified), balances: await balances(row.id) })),
  );
  return { items, total: Number(total?.value ?? 0), limit: query.limit, offset: query.offset };
}

/** Manual correction by an admin (e.g. consultations completed before the ledger existed). */
export async function adjustBalance(doctorId: string, input: { amount: number; currency: string; reason: string }, adminName: string) {
  if (input.amount === 0) throw badRequest('Enter an amount other than zero');
  const currency = input.currency.toUpperCase();
  await db.transaction(async (tx) => {
    await lockDoctor(tx, doctorId);
    const { balance } = await balanceIn(doctorId, currency, tx);
    if (input.amount < 0 && balance + input.amount < 0) throw badRequest(`The balance is only ${formatAmount(balance, currency)}`);
    await post(tx, { doctorId, type: 'adjustment', amount: input.amount, currency, description: input.reason, createdBy: adminName });
  });
  return balances(doctorId);
}
