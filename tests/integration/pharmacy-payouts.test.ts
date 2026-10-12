import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { admins, orders, pharmacies, pharmacyLedger, pharmacyPayouts, pharmacyStaff } from '../../src/db/schema/index.js';
import { ProviderError } from '../../src/integrations/payments/types.js';
import { setTransferGateway, type TransferGateway, type TransferResult } from '../../src/integrations/payments/transfers.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken, signPharmacyAccessToken, signPharmacyStaffAccessToken } from '../../src/lib/tokens.js';
import { sweepUnsettledOrders } from '../../src/modules/payouts/payouts.ledger.js';
import { handleTransferEvent, reconcilePayouts, runWeeklyPayouts } from '../../src/modules/payouts/payouts.service.js';
import { clearingTime, savePayoutSettings, scheduledSlot } from '../../src/modules/payouts/payouts.settings.js';
import { api, createUser, resetDatabase } from '../helpers.js';

const portal = '/api/v1/pharmacy-portal';
const admin = '/api/v1/admin';

/** A stand-in for Paystack: records transfers and answers as each test needs. */
class FakeGateway implements TransferGateway {
  transfers: Array<{ reference: string; amountMinor: number; recipientCode: string }> = [];
  initiateResult: TransferResult | Error = { status: 'pending', transferCode: 'TRF_1' };
  verifyResult: TransferResult | null = { status: 'success', transferCode: 'TRF_1' };
  async listBanks() { return [{ name: 'Access Bank', code: '044' }, { name: 'GTBank', code: '058' }]; }
  async resolveAccount(accountNumber: string) {
    if (accountNumber === '0000000000') throw new ProviderError('paystack', 'Could not resolve account name', undefined, 422);
    return { accountName: 'COUNTER PHARMACY LTD' };
  }
  async createRecipient() { return { recipientCode: 'RCP_test' }; }
  async initiate(input: { reference: string; amountMinor: number; recipientCode: string }) {
    if (this.initiateResult instanceof Error) throw this.initiateResult;
    this.transfers.push(input);
    return this.initiateResult;
  }
  async verify() { return this.verifyResult; }
  async balance() { return { currency: 'NGN', amount: 500000 }; }
}

let gateway: FakeGateway;

async function setup() {
  const pharmacyId = newId();
  await db.insert(pharmacies).values({ id: pharmacyId, name: 'Counter Pharmacy', email: `${pharmacyId}@pharmacy.test`, status: 'active' });
  const managerId = newId();
  await db.insert(pharmacyStaff).values({ id: managerId, pharmacyId, name: 'Mo Manager', email: `${managerId}@staff.test`, role: 'manager' });
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops Admin', email: `${adminId}@admin.test`, role: 'admin' });
  const customer = await createUser();
  return {
    pharmacyId,
    customerId: customer.id,
    owner: `Bearer ${signPharmacyAccessToken(pharmacyId)}`,
    manager: `Bearer ${signPharmacyStaffAccessToken(pharmacyId, managerId, 0)}`,
    admin: `Bearer ${signAdminAccessToken({ sub: adminId, role: 'admin' })}`,
  };
}

/** Delivers an order; by default also lets its earning clear, as if 6 AM next day has come. */
async function deliveredOrder(ctx: Awaited<ReturnType<typeof setup>>, earning: number, options: { cleared?: boolean } = {}) {
  const id = newId();
  await db.insert(orders).values({ id, userId: ctx.customerId, pharmacyId: ctx.pharmacyId, trackingId: id.slice(0, 10).toUpperCase(), status: 'delivering', subtotal: earning, deliveryFee: 0, totalAmount: earning, pharmacyEarning: earning });
  const res = await api().post(`${portal}/orders/${id}/actions`).set('Authorization', ctx.owner).send({ action: 'deliver' });
  expect(res.status).toBe(200);
  if (options.cleared !== false) await db.update(pharmacyLedger).set({ availableAt: new Date(Date.now() - 1000) }).where(eq(pharmacyLedger.orderId, id));
  return id;
}

const addBank = (ctx: Awaited<ReturnType<typeof setup>>) =>
  api().put(`${portal}/payouts/bank-account`).set('Authorization', ctx.owner).send({ bankCode: '058', accountNumber: '0123456789' });
const summary = async (ctx: Awaited<ReturnType<typeof setup>>) => (await api().get(`${portal}/payouts/summary`).set('Authorization', ctx.owner)).body;

describe('pharmacy earnings and payouts', () => {
  beforeEach(async () => {
    await resetDatabase();
    gateway = new FakeGateway();
    setTransferGateway(gateway);
  });
  afterEach(() => setTransferGateway(null));

  it('credits a delivered order once and clears it at 6 AM Lagos the next day', async () => {
    const ctx = await setup();
    const orderId = await deliveredOrder(ctx, 9500, { cleared: false });
    expect(await summary(ctx)).toMatchObject({ balance: 9500, available: 0, pending: 9500 });
    expect(await sweepUnsettledOrders()).toBe(0);
    const [entry] = await db.select().from(pharmacyLedger).where(eq(pharmacyLedger.orderId, orderId));
    expect(entry!.availableAt.toISOString()).toBe(clearingTime(entry!.createdAt, 6).toISOString());
    expect(entry!.availableAt.getUTCHours()).toBe(5);
  });

  it('moves waiting earnings when the clearing hour changes', async () => {
    const ctx = await setup();
    const orderId = await deliveredOrder(ctx, 9500, { cleared: false });
    await savePayoutSettings({ clearingHour: 9 });
    const [entry] = await db.select().from(pharmacyLedger).where(eq(pharmacyLedger.orderId, orderId));
    expect(entry!.availableAt.toISOString()).toBe(clearingTime(entry!.createdAt, 9).toISOString());
  });

  it('reverses the earning when an admin undoes a completed order, and re-credits it', async () => {
    const ctx = await setup();
    const orderId = await deliveredOrder(ctx, 4000);
    await api().patch(`${admin}/orders/${orderId}/status`).set('Authorization', ctx.admin).send({ status: 'cancelled' });
    expect((await summary(ctx)).balance).toBe(0);
    await api().patch(`${admin}/orders/${orderId}/status`).set('Authorization', ctx.admin).send({ status: 'completed' });
    expect((await summary(ctx)).balance).toBe(4000);
    const entries = await db.select().from(pharmacyLedger).where(eq(pharmacyLedger.orderId, orderId));
    expect(entries.map((e) => e.amount)).toEqual(expect.arrayContaining([4000, -4000, 4000]));
  });

  it('verifies the bank account by name and refuses unknown accounts', async () => {
    const ctx = await setup();
    const bad = await api().put(`${portal}/payouts/bank-account`).set('Authorization', ctx.owner).send({ bankCode: '058', accountNumber: '0000000000' });
    expect(bad.status).toBe(422);
    const res = await addBank(ctx);
    expect(res.body).toMatchObject({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'COUNTER PHARMACY LTD' });
    expect((await api().put(`${portal}/payouts/bank-account`).set('Authorization', ctx.manager).send({ bankCode: '058', accountNumber: '0123456789' })).status).toBe(403);
  });

  it('runs an on-demand withdrawal from request to paid', async () => {
    const ctx = await setup();
    await deliveredOrder(ctx, 10000);
    expect((await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 5000 })).body.error.code).toBe('NO_BANK_ACCOUNT');
    await addBank(ctx);
    expect((await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 0 })).status).toBe(400);
    expect((await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 20000 })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await api().post(`${portal}/payouts`).set('Authorization', ctx.manager).send({ amount: 5000 })).status).toBe(403);

    const requested = await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 6000 });
    expect(requested.status).toBe(201);
    expect(requested.body).toMatchObject({ status: 'pending_approval', amount: 6000, trigger: 'on_demand', accountName: 'COUNTER PHARMACY LTD' });
    expect(await summary(ctx)).toMatchObject({ balance: 4000, available: 4000 });
    expect((await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 1000 })).body.error.code).toBe('PAYOUT_IN_PROGRESS');
    expect((await addBank(ctx)).body.error.code).toBe('PAYOUT_IN_PROGRESS');

    const approved = await api().post(`${admin}/payouts/${requested.body.id}/approve`).set('Authorization', ctx.admin);
    expect(approved.body).toMatchObject({ status: 'processing', approvedBy: expect.stringContaining('Ops Admin'), transferCode: 'TRF_1' });
    expect(gateway.transfers).toEqual([{ reference: requested.body.reference, amountMinor: 600000, recipientCode: 'RCP_test', reason: expect.any(String) }]);
    expect((await api().post(`${admin}/payouts/${requested.body.id}/approve`).set('Authorization', ctx.admin)).status).toBe(400);

    await handleTransferEvent(requested.body.reference);
    const [paid] = await db.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.id, requested.body.id));
    expect(paid).toMatchObject({ status: 'paid' });
    expect(await summary(ctx)).toMatchObject({ balance: 4000, totalPaidOut: 6000, openPayout: null });
  });

  it('keeps a refused transfer in the queue and returns money when a transfer fails', async () => {
    const ctx = await setup();
    await deliveredOrder(ctx, 8000);
    await addBank(ctx);
    const { body: payout } = await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 8000 });

    gateway.initiateResult = new ProviderError('paystack', 'Your balance is not enough to fulfil this request', undefined, 400);
    const refused = await api().post(`${admin}/payouts/${payout.id}/approve`).set('Authorization', ctx.admin);
    expect(refused.body.error.code).toBe('TRANSFER_REFUSED');
    const [queued] = await db.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.id, payout.id));
    expect(queued).toMatchObject({ status: 'pending_approval', lastError: 'Your balance is not enough to fulfil this request' });

    gateway.initiateResult = { status: 'failed', transferCode: 'TRF_2', reason: 'Account closed' };
    await api().post(`${admin}/payouts/${payout.id}/approve`).set('Authorization', ctx.admin);
    const [failed] = await db.select().from(pharmacyPayouts).where(eq(pharmacyPayouts.id, payout.id));
    expect(failed).toMatchObject({ status: 'failed', lastError: 'Account closed' });
    expect(await summary(ctx)).toMatchObject({ balance: 8000, available: 8000 });
  });

  it('lets the owner cancel and an admin decline, returning the money each time', async () => {
    const ctx = await setup();
    await deliveredOrder(ctx, 3000);
    await addBank(ctx);
    const first = await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 3000 });
    await api().post(`${portal}/payouts/${first.body.id}/cancel`).set('Authorization', ctx.owner);
    expect((await summary(ctx)).available).toBe(3000);
    const second = await api().post(`${portal}/payouts`).set('Authorization', ctx.owner).send({ amount: 3000 });
    const declined = await api().post(`${admin}/payouts/${second.body.id}/reject`).set('Authorization', ctx.admin).send({ reason: 'Bank details under review' });
    expect(declined.body).toMatchObject({ status: 'rejected', rejectionReason: 'Bank details under review' });
    expect((await summary(ctx)).available).toBe(3000);
  });

  it('pays out weekly once per slot, skipping pharmacies with a payout in progress', async () => {
    const ctx = await setup();
    await savePayoutSettings({ autoApproveScheduled: false });
    await deliveredOrder(ctx, 5000);
    await addBank(ctx);
    const run = await runWeeklyPayouts();
    expect(run).toMatchObject({ payoutCount: 1, totalAmount: 5000 });
    expect(await runWeeklyPayouts()).toBeNull();
    const [scheduled] = await db.select().from(pharmacyPayouts);
    expect(scheduled).toMatchObject({ trigger: 'scheduled', status: 'pending_approval', amount: 5000 });

    const bulk = await api().post(`${admin}/payouts/approve`).set('Authorization', ctx.admin).send({ ids: [scheduled!.id] });
    expect(bulk.body.results[0]).toMatchObject({ ok: true, status: 'processing' });
    gateway.verifyResult = { status: 'success', transferCode: 'TRF_1' };
    await db.update(pharmacyPayouts).set({ updatedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(pharmacyPayouts.id, scheduled!.id));
    expect(await reconcilePayouts()).toBe(1);
    const [paid] = await db.select().from(pharmacyPayouts);
    expect(paid?.status).toBe('paid');
  });

  it('lets an admin settle older earnings with an adjustment', async () => {
    const ctx = await setup();
    const res = await api().post(`${admin}/pharmacies/${ctx.pharmacyId}/ledger-adjustments`).set('Authorization', ctx.admin).send({ amount: 12500, reason: 'Earnings before payouts launched' });
    expect(res.body).toMatchObject({ balance: 12500, available: 12500 });
    const ledger = await api().get(`${admin}/pharmacies/${ctx.pharmacyId}/ledger`).set('Authorization', ctx.admin);
    expect(ledger.body.items[0]).toMatchObject({ type: 'adjustment', amount: 12500, createdBy: expect.stringContaining('Ops Admin') });
    expect((await api().post(`${admin}/pharmacies/${ctx.pharmacyId}/ledger-adjustments`).set('Authorization', ctx.admin).send({ amount: -20000, reason: 'Too much' })).status).toBe(400);
  });
});

describe('daily clearing time', () => {
  it('clears at 6 AM Lagos on the next Lagos day, whatever time the order was delivered', () => {
    // 09:00 and 23:30 Lagos on Tuesday 13 Oct both clear at 06:00 Lagos Wednesday (05:00 UTC).
    expect(clearingTime(new Date('2026-10-13T08:00:00Z'), 6).toISOString()).toBe('2026-10-14T05:00:00.000Z');
    expect(clearingTime(new Date('2026-10-13T22:30:00Z'), 6).toISOString()).toBe('2026-10-14T05:00:00.000Z');
    // 00:30 Lagos Wednesday is already Wednesday in Lagos (23:30 UTC Tuesday): clears Thursday.
    expect(clearingTime(new Date('2026-10-13T23:30:00Z'), 6).toISOString()).toBe('2026-10-15T05:00:00.000Z');
  });
});

describe('weekly payout slot', () => {
  it('lands on the configured Lagos weekday and hour', () => {
    // Wednesday 2026-10-14 12:00 Lagos (11:00 UTC); Monday 09:00 Lagos is 08:00 UTC.
    const slot = scheduledSlot({ weekday: 1, hour: 9 }, new Date('2026-10-14T11:00:00Z'));
    expect(slot.current.toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(slot.next.toISOString()).toBe('2026-10-19T08:00:00.000Z');
    // Monday 08:30 Lagos: this week's run hasn't come yet.
    expect(scheduledSlot({ weekday: 1, hour: 9 }, new Date('2026-10-12T07:30:00Z')).current.toISOString()).toBe('2026-10-05T08:00:00.000Z');
  });
});
