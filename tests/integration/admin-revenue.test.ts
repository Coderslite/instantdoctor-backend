import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, appointments, hmoClaims, hmos, labResults, orderCheckouts, orders, payments, pharmacies } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

// Test FX (helpers): ₦1,500 = $1 and £0.80 = $1, so £1 = ₦1,875.
const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const now = new Date();

let patientId: string;
const appointment = (values: Partial<typeof appointments.$inferInsert>) => {
  const id = newId();
  return db
    .insert(appointments)
    .values({ id, userId: patientId, symptoms: [], packageLabel: 'GP', startTime: now, endTime: now, price: 0, isPaid: true, paidAt: now, currency: 'NGN', ...values })
    .then(() => id);
};
const payment = (values: Partial<typeof payments.$inferInsert>) =>
  db.insert(payments).values({
    id: newId(),
    reference: newId(),
    userId: patientId,
    purpose: 'family_subscription',
    provider: 'paystack',
    status: 'succeeded',
    baseAmount: 0,
    amount: 0,
    amountMinor: 0,
    currency: 'NGN',
    paidAt: now,
    ...values,
  });

describe('admin revenue report', () => {
  beforeEach(() => resetDatabase());

  it('adds up each stream per currency, never across currencies, with a naira equivalent at today’s rates', async () => {
    patientId = (await createUser({ country: 'NG', currency: 'NGN' })).id;

    // Consultations: ₦7,500 less ₦4,500 to the doctor; £10 less £6; a refunded booking earns nothing;
    // a cancelled unrefunded one keeps its price; a free trial isn't income; an HMO visit's ₦0 price less the doctor's ₦3,600.
    await appointment({ price: 7_500, doctorEarning: 4_500, status: 'completed' });
    await appointment({ price: 10, doctorEarning: 6, currency: 'GBP', status: 'completed' });
    await appointment({ price: 5_000, status: 'cancelled', refundedAmount: 5_000, refundedAt: now });
    await appointment({ price: 2_000, status: 'cancelled' });
    await appointment({ price: 0, isTrial: true, status: 'completed' });
    const hmoVisit = await appointment({ price: 0, doctorEarning: 3_600, status: 'completed' });
    // Migrated from Firebase: paid, but no payment time recorded — dated by when it was booked.
    await appointment({ price: 1_000, doctorEarning: 600, status: 'completed', paidAt: null });

    // Lab review fee, and one still unpaid.
    await db.insert(labResults).values([
      { id: newId(), userId: patientId, status: 'pending', price: 3_000, currency: 'NGN' },
      { id: newId(), userId: patientId, status: 'awaiting_payment', price: 3_000, currency: 'NGN' },
    ]);

    // Pharmacy: ₦500 commission plus the ₦200 service charge; a cancelled (refunded) order counts for nothing.
    const pharmacyId = newId();
    await db.insert(pharmacies).values({ id: pharmacyId, name: 'HealthPlus', email: 'hp@pharmacy.test' });
    const checkout = newId();
    await db.insert(orderCheckouts).values({ id: checkout, userId: patientId, subtotal: 10_000, deliveryFee: 1_000, totalAmount: 11_000, currency: 'NGN', status: 'paid' });
    await db.insert(orders).values([
      { id: newId(), checkoutId: checkout, userId: patientId, pharmacyId, trackingId: 'T1', status: 'completed', subtotal: 10_000, deliveryFee: 1_000, totalAmount: 11_000, platformEarning: 500, pharmacyEarning: 10_500 },
    ]);
    await payment({ purpose: 'order_checkout', purposeRefId: checkout, baseAmount: 11_000, surcharge: 200, amount: 11_200 });
    const lost = newId();
    await db.insert(orderCheckouts).values({ id: lost, userId: patientId, subtotal: 4_000, deliveryFee: 500, totalAmount: 4_500, currency: 'NGN', status: 'paid' });
    await db.insert(orders).values({ id: newId(), checkoutId: lost, userId: patientId, pharmacyId, trackingId: 'T2', status: 'cancelled', subtotal: 4_000, deliveryFee: 500, totalAmount: 4_500, platformEarning: 200 });

    // Family Care membership; a wallet top-up isn't income.
    await payment({ purpose: 'family_subscription', baseAmount: 5_000, amount: 5_000 });
    await payment({ purpose: 'wallet_topup', baseAmount: 20_000, amount: 20_000 });

    // HMO: ₦6,000 billed for the consultation; a medicine claim only repays the pharmacy.
    const hmoId = newId();
    await db.insert(hmos).values({ id: hmoId, name: 'Avon HMO', code: 'AVON' });
    const claim = { hmoId, userId: patientId, description: 'x', enrolleeCode: 'AVN-1', coverage: 'full' as const, standardAmount: 7_500, patientAmount: 0, serviceDate: now };
    await db.insert(hmoClaims).values([
      { id: newId(), ...claim, service: 'consultation', appointmentId: hmoVisit, hmoAmount: 6_000 },
      { id: newId(), ...claim, service: 'medicines', hmoAmount: 2_000 },
    ]);

    const adminId = newId();
    await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
    const res = await api().get(`/api/v1/admin/revenue?from=${thisMonth}-01&to=${today}`).set(auth(signAdminAccessToken({ sub: adminId, role: 'admin' })));
    expect(res.status).toBe(200);
    const stream = (key: string) => res.body.streams.find((s: { stream: string }) => s.stream === key);

    expect(stream('consultations')).toMatchObject({ byCurrency: { NGN: 3_000 + 0 + 2_000 - 3_600 + 400, GBP: 4 }, ngnEquivalent: 1_800 + 4 * 1_875, count: 6 });
    expect(stream('lab_reviews')).toMatchObject({ byCurrency: { NGN: 3_000 }, count: 1 });
    expect(stream('pharmacy')).toMatchObject({ byCurrency: { NGN: 700 }, count: 1 });
    expect(stream('family_care')).toMatchObject({ byCurrency: { NGN: 5_000 } });
    expect(stream('hmo_billing')).toMatchObject({ byCurrency: { NGN: 6_000 }, count: 1 });
    expect(stream('hmo_capitation')).toMatchObject({ byCurrency: {}, ngnEquivalent: 0 });
    expect(res.body.total).toEqual({ byCurrency: { NGN: 16_500, GBP: 4 }, ngnEquivalent: 16_500 + 7_500 });
    // Collected: what was paid for all of it, before doctor and pharmacy shares (refunds excluded).
    const collectedNgn = 7_500 + 2_000 + 1_000 + 3_000 + 11_000 + 200 + 5_000 + 6_000;
    expect(res.body.collected).toEqual({ byCurrency: { NGN: collectedNgn, GBP: 10 }, ngnEquivalent: collectedNgn + 10 * 1_875 });
    expect(res.body.rates.GBP).toBeCloseTo(1_875);
    expect(res.body.monthly).toHaveLength(12);
    expect(res.body.monthly.at(-1)).toMatchObject({ month: thisMonth, ngnEquivalent: 24_000 });

    // The overview cards use the same figures; escrow is what doctors are owed now (none in this test).
    const overview = await api().get('/api/v1/admin/dashboard').set(auth(signAdminAccessToken({ sub: adminId, role: 'admin' })));
    expect(overview.body).toMatchObject({ platformEarnings: 24_000, revenue: collectedNgn + 18_750, doctorEscrow: 0 });

    // Outside the period: nothing.
    const empty = await api().get('/api/v1/admin/revenue?from=2020-01-01&to=2020-01-31').set(auth(signAdminAccessToken({ sub: adminId, role: 'admin' })));
    expect(empty.body.total).toEqual({ byCurrency: {}, ngnEquivalent: 0 });
  });
});
