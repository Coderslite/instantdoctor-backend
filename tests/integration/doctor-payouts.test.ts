import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { admins, appointments, doctorLedger, doctorPayouts } from '../../src/db/schema/index.js';
import { ProviderError } from '../../src/integrations/payments/types.js';
import { setTransferGateway, type TransferGateway, type TransferResult } from '../../src/integrations/payments/transfers.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { balances } from '../../src/modules/doctor-payouts/doctor-payouts.ledger.js';
import { handleTransferEvent, runWeeklyPayouts } from '../../src/modules/doctor-payouts/doctor-payouts.service.js';
import { api, auth, createDoctor, createUser, inHours, resetDatabase } from '../helpers.js';

/** A stand-in for Paystack. */
class FakeGateway implements TransferGateway {
  transfers: Array<{ reference: string; amountMinor: number; recipientCode: string }> = [];
  initiateResult: TransferResult | Error = { status: 'pending', transferCode: 'TRF_1' };
  verifyResult: TransferResult | null = { status: 'success', transferCode: 'TRF_1' };
  async listBanks() { return [{ name: 'Access Bank', code: '044' }]; }
  async resolveAccount(accountNumber: string) {
    if (accountNumber === '0000000000') throw new ProviderError('paystack', 'Could not resolve account name', undefined, 422);
    return { accountName: 'ADA BELLO' };
  }
  async createRecipient() { return { recipientCode: 'RCP_doc' }; }
  async initiate(input: { reference: string; amountMinor: number; recipientCode: string }) {
    if (this.initiateResult instanceof Error) throw this.initiateResult;
    this.transfers.push(input);
    return this.initiateResult;
  }
  async verify() { return this.verifyResult; }
  async balance() { return { currency: 'NGN', amount: 500000 }; }
}

let gateway: FakeGateway;
let adminToken: string;

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set(auth(token)),
  post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(auth(token)).send(b),
  put: (p: string, b: object = {}) => api().put(`/api/v1${p}`).set(auth(token)).send(b),
});

/** A paid consultation in progress with this doctor, earning them ₦4,500. */
async function activeVisit(doctorId: string, patientId: string, earning = 4_500) {
  const id = newId();
  await db.insert(appointments).values({
    id, userId: patientId, doctorId, symptoms: [], status: 'active', packageLabel: 'GP',
    startTime: inHours(-1), endTime: inHours(0), price: 7_500, currency: 'NGN', isPaid: true, doctorEarning: earning,
  });
  return id;
}

/** Lets every earning clear, as if 6 AM the next day has come. */
const clearAll = () => db.update(doctorLedger).set({ availableAt: new Date(Date.now() - 60_000) });

const ngnBalance = async (doctorId: string) => (await balances(doctorId)).find((b) => b.currency === 'NGN');

beforeEach(async () => {
  await resetDatabase();
  gateway = new FakeGateway();
  setTransferGateway(gateway);
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
});
afterEach(() => setTransferGateway(null));

describe('doctor earnings', () => {
  it('completing a paid consultation credits the doctor after clearing; cancelling takes it back; a patient deleting it does not', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    const visit = await activeVisit(doctor.id, patient.id);
    expect((await as(doctor.token).post(`/appointments/${visit}/status`, { status: 'completed' })).status).toBe(200);

    let summary = (await as(doctor.token).get('/doctor-earnings')).body;
    expect(summary.balances).toEqual([{ currency: 'NGN', balance: 4_500, available: 0, pending: 4_500 }]);
    await clearAll();
    expect(await ngnBalance(doctor.id)).toMatchObject({ available: 4_500 });

    // The patient tidying their list keeps the doctor's pay.
    await db.update(appointments).set({ status: 'deleted' }).where(eq(appointments.id, visit));
    const second = await activeVisit(doctor.id, patient.id, 3_000);
    await as(doctor.token).post(`/appointments/${second}/status`, { status: 'completed' });
    expect(await ngnBalance(doctor.id)).toMatchObject({ balance: 7_500 });

    // An admin cancelling a completed consultation reverses its earning once.
    await api().patch(`/api/v1/admin/appointments/${second}/status`).set(auth(adminToken)).send({ status: 'cancelled' });
    expect(await ngnBalance(doctor.id)).toMatchObject({ balance: 4_500 });
    summary = (await as(doctor.token).get('/doctor-earnings/ledger')).body;
    expect(summary.items.map((e: { type: string }) => e.type)).toEqual(['earning_reversal', 'earning', 'earning']);
  });

  it('a doctor withdraws to a bank-verified account; approval sends it by Paystack and the webhook settles it', async () => {
    const doctor = await createDoctor({ firstName: 'Ada', lastName: 'Bello' });
    const patient = await createUser();
    await as(doctor.token).post(`/appointments/${await activeVisit(doctor.id, patient.id)}/status`, { status: 'completed' });
    await clearAll();

    const noBank = await as(doctor.token).post('/doctor-earnings/payouts', { amount: 4_500 });
    expect(noBank.body.error.code).toBe('NO_BANK_ACCOUNT');
    const wrong = await as(doctor.token).put('/doctor-earnings/bank-account', { bankCode: '044', accountNumber: '0000000000' });
    expect(wrong.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    const bank = await as(doctor.token).put('/doctor-earnings/bank-account', { bankCode: '044', accountNumber: '0123456789' });
    expect(bank.body.bankAccount).toMatchObject({ bankName: 'Access Bank', accountName: 'ADA BELLO', verified: true });

    const tooMuch = await as(doctor.token).post('/doctor-earnings/payouts', { amount: 5_000 });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const request = await as(doctor.token).post('/doctor-earnings/payouts', { amount: 4_500 });
    expect(request.status).toBe(201);
    expect(request.body).toMatchObject({ method: 'paystack', status: 'pending_approval', currency: 'NGN' });
    expect(await ngnBalance(doctor.id)).toMatchObject({ balance: 0 }); // reserved
    const twice = await as(doctor.token).post('/doctor-earnings/payouts', { amount: 1 });
    expect(twice.body.error.code).toBe('PAYOUT_IN_PROGRESS');
    const changeBank = await as(doctor.token).put('/doctor-earnings/bank-account', { bankCode: '044', accountNumber: '0123456780' });
    expect(changeBank.body.error.code).toBe('PAYOUT_IN_PROGRESS');

    const approved = await api().post(`/api/v1/admin/doctor-payouts/${request.body.id}/approve`).set(auth(adminToken)).send({});
    expect(approved.body.status).toBe('processing');
    expect(gateway.transfers).toEqual([expect.objectContaining({ amountMinor: 450_000, recipientCode: 'RCP_doc' })]);
    await handleTransferEvent(request.body.reference);
    const [paid] = await db.select().from(doctorPayouts).where(eq(doctorPayouts.id, request.body.id));
    expect(paid!.status).toBe('paid');
  });

  it('a failed transfer returns the money to the balance', async () => {
    const doctor = await createDoctor();
    const patient = await createUser();
    await as(doctor.token).post(`/appointments/${await activeVisit(doctor.id, patient.id)}/status`, { status: 'completed' });
    await clearAll();
    await as(doctor.token).put('/doctor-earnings/bank-account', { bankCode: '044', accountNumber: '0123456789' });
    const request = await as(doctor.token).post('/doctor-earnings/payouts', { amount: 4_500 });
    gateway.initiateResult = { status: 'failed', transferCode: 'TRF_2', reason: 'Account closed' };
    await api().post(`/api/v1/admin/doctor-payouts/${request.body.id}/approve`).set(auth(adminToken)).send({});
    expect(await ngnBalance(doctor.id)).toMatchObject({ balance: 4_500, available: 4_500 });
  });

  it('the weekly run pays every doctor with cleared earnings; a doctor abroad is paid manually with a reference', async () => {
    const local = await createDoctor();
    const abroad = await createDoctor({ earningCurrency: 'USD' });
    const patient = await createUser();
    await as(local.token).post(`/appointments/${await activeVisit(local.id, patient.id)}/status`, { status: 'completed' });
    const usdVisit = await activeVisit(abroad.id, patient.id);
    await db.update(appointments).set({ doctorEarningConverted: 3, doctorEarningCurrency: 'USD' }).where(eq(appointments.id, usdVisit));
    await as(abroad.token).post(`/appointments/${usdVisit}/status`, { status: 'completed' });
    await clearAll();
    await as(local.token).put('/doctor-earnings/bank-account', { bankCode: '044', accountNumber: '0123456789' });
    await as(abroad.token).put('/doctor-earnings/bank-account', { bankName: 'Barclays UK', accountNumber: 'GB29NWBK60161331926819', accountName: 'Dr Abroad' });

    const run = await runWeeklyPayouts({ manual: 'Test admin' });
    expect(run).toMatchObject({ payoutCount: 2, totals: { NGN: 4_500, USD: 3 } });
    const list = await api().get('/api/v1/admin/doctor-payouts?status=pending_approval').set(auth(adminToken));
    const manual = list.body.items.find((p: { currency: string }) => p.currency === 'USD');
    expect(manual).toMatchObject({ method: 'manual', trigger: 'scheduled', amount: 3 });

    const noRef = await api().post(`/api/v1/admin/doctor-payouts/${manual.id}/approve`).set(auth(adminToken)).send({});
    expect(noRef.status).toBe(400);
    const recorded = await api().post(`/api/v1/admin/doctor-payouts/${manual.id}/approve`).set(auth(adminToken)).send({ paymentReference: 'WISE-123' });
    expect(recorded.body).toMatchObject({ status: 'paid', paymentReference: 'WISE-123' });
    expect(gateway.transfers).toEqual([]); // nothing sent by Paystack for it

  });
});
