import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import {
  admins,
  appointments,
  hmoClaims,
  orderCheckouts,
  orders,
  pharmacies,
  products,
  walletTransactions,
} from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken, signPharmacyAccessToken } from '../../src/lib/tokens.js';
import { confirmCheckout } from '../../src/modules/payments/fulfillment.js';
import { getFeePolicy, orderSurcharge, pharmacySplit } from '../../src/modules/pricing/fees.js';
import { api, auth, createDoctor, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const HERE = { latitude: 4.95, longitude: 8.32 };
const allWeek = { open: '00:00', close: '23:59' };
const everyDay = { mon: allWeek, tue: allWeek, wed: allWeek, thu: allWeek, fri: allWeek, sat: allWeek, sun: allWeek };

let adminToken: string;
let doctor: { id: string; token: string };
let pharmacyId: string;
const product: Record<string, string> = {};

const as = (token: string) => ({
  get: (p: string) => api().get(`/api/v1${p}`).set(auth(token)),
  post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(auth(token)).send(b),
  patch: (p: string, b: object = {}) => api().patch(`/api/v1${p}`).set(auth(token)).send(b),
});
const portal = () => as(signPharmacyAccessToken(pharmacyId));

async function visit(patientId: string, status: 'pending' | 'active' | 'completed' = 'completed') {
  const id = newId();
  await db.insert(appointments).values({
    id,
    userId: patientId,
    doctorId: doctor.id,
    symptoms: [],
    status,
    packageLabel: 'Standard',
    startTime: inHours(-2),
    endTime: inHours(-1),
    price: 7500,
    currency: 'NGN',
    isPaid: true,
  });
  return id;
}

const PRESCRIPTION = {
  items: [
    { name: 'Amoxicillin', strength: '500mg', form: 'capsule', directions: '1 capsule three times daily', durationDays: 7, quantity: 2 },
    { name: 'Paracetamol', strength: '500mg', form: 'tablet', directions: '2 tablets when needed, up to 4 times a day', quantity: 1 },
  ],
  notes: 'Drink plenty of water.',
};

/** A patient on an HMO plan whose medicines rule is a 10% co-pay, capped at ₦4,000 a year. */
async function hmoPatient(medicineRule: object = { coverage: 'copay_percent', percent: 10, limitAmount: 4_000, limitPeriod: 'year' }) {
  const hmo = await as(adminToken).post('/admin/hmos', { name: 'Avon Healthcare HMO', code: 'avon' });
  const plan = await as(adminToken).post(`/admin/hmos/${hmo.body.id}/plans`, { name: 'Gold' });
  const planId = plan.body.plans[0].id;
  const rule = await as(adminToken).post(`/admin/hmos/${hmo.body.id}/plans/${planId}/rules`, { service: 'medicines', ...medicineRule });
  expect(rule.status).toBe(201);
  const email = 'ada@patient.test';
  const patient = await createUser({ email, country: 'NG', currency: 'NGN', firstName: 'Ada', lastName: 'Okafor' });
  const enrol = await as(adminToken).post(`/admin/hmos/${hmo.body.id}/enrollees`, { planId, enrolleeCode: 'AVN-001', email });
  expect(enrol.body.userId).toBe(patient.id);
  return { patient, hmoId: hmo.body.id as string };
}

async function prescribe(patientId: string, body: object = PRESCRIPTION) {
  const appointmentId = await visit(patientId);
  const res = await as(doctor.token).post(`/appointments/${appointmentId}/prescriptions`, body);
  expect(res.status).toBe(201);
  return { appointmentId, prescription: res.body };
}

const line = (prescription: { items: Array<{ id: string; name: string }> }, name: string) =>
  prescription.items.find((i) => i.name === name)!.id;

beforeEach(async () => {
  await resetDatabase();
  const adminId = newId();
  await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
  adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
  doctor = await createDoctor({ firstName: 'Bola', lastName: 'Ade' });
  pharmacyId = newId();
  await db.insert(pharmacies).values({
    id: pharmacyId,
    name: 'SpringZone',
    email: `${pharmacyId}@pharmacy.test`,
    ...HERE,
    deliveryFeePerKm: 100,
    status: 'active',
    openingHours: everyDay,
  });
  for (const [key, name, amount] of [
    ['amox500', 'Amoxicillin 500mg Capsules x21', 2_000],
    ['amox250', 'Amoxicillin 250mg Capsules', 1_500],
    ['para', 'Paracetamol 500mg Tablets', 500],
    ['vitc', 'Vitamin C 1000mg', 800],
  ] as const) {
    product[key] = newId();
    await db.insert(products).values({ id: product[key]!, pharmacyId, name, amount, stockRemaining: 10, images: [] });
  }
});

describe('e-prescriptions', () => {
  it('a doctor can prescribe during an ongoing consultation but not before accepting it', async () => {
    const patient = await createUser();
    const ongoing = await visit(patient.id, 'active');
    expect((await as(doctor.token).post(`/appointments/${ongoing}/prescriptions`, PRESCRIPTION)).status).toBe(201);
    const unaccepted = await visit(patient.id, 'pending');
    const res = await as(doctor.token).post(`/appointments/${unaccepted}/prescriptions`, PRESCRIPTION);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('APPOINTMENT_NOT_ACCEPTED');
  });

  it('a doctor issues structured items with a code; older text-only prescriptions still work', async () => {
    const patient = await createUser();
    const { appointmentId, prescription } = await prescribe(patient.id);
    expect(prescription.code).toMatch(/^RX-[A-Z0-9]{6}$/);
    expect(prescription.doctorName).toBe('Dr Bola Ade');
    expect(prescription.canOrder).toBe(true);
    expect(prescription.items).toHaveLength(2);
    expect(prescription.items[0]).toMatchObject({ name: 'Amoxicillin', quantity: 2, remaining: 2 });
    expect(prescription.prescription).toContain('1. Amoxicillin 500mg (capsule)');
    expect(prescription.prescription).toContain('Drink plenty of water.');

    const legacy = await as(doctor.token).post(`/appointments/${appointmentId}/prescriptions`, {
      prescription: 'Rest and fluids',
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body).toMatchObject({ prescription: 'Rest and fluids', items: [], canOrder: false });

    const mine = await as(patient.token).get('/prescriptions');
    expect(mine.body.items).toHaveLength(2);
  });

  it('suggests pharmacies with the right medicine and strength', async () => {
    const patient = await createUser({ country: 'NG', currency: 'NGN' });
    const { prescription } = await prescribe(patient.id);
    const res = await as(patient.token).get(
      `/prescriptions/${prescription.id}/pharmacies?latitude=${HERE.latitude}&longitude=${HERE.longitude}`,
    );
    expect(res.status).toBe(200);
    const [option] = res.body.items;
    expect(option).toMatchObject({ available: 2, total: 2, subtotal: 4_500, deliveryFee: 100, hmo: null });
    const amox = option.items.find((i: { name: string }) => i.name === 'Amoxicillin');
    expect(amox.candidates.map((c: { id: string }) => c.id)).toEqual([product.amox500]); // never the 250mg
    expect(amox.suggestedQuantity).toBe(2);
  });

  it('checks prescribed cart lines: right medicine, quantity left, own prescription', async () => {
    const patient = await createUser({ country: 'NG', currency: 'NGN' });
    const other = await createUser();
    const { prescription } = await prescribe(patient.id);
    const amox = line(prescription, 'Amoxicillin');
    const quote = (token: string, items: object[]) => as(token).post('/orders/quote', { items, location: HERE });

    const wrong = await quote(patient.token, [{ productId: product.amox250, quantity: 1, prescriptionItemId: amox }]);
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('PRESCRIPTION_MISMATCH');

    const tooMany = await quote(patient.token, [{ productId: product.amox500, quantity: 3, prescriptionItemId: amox }]);
    expect(tooMany.body.error.code).toBe('PRESCRIPTION_QUANTITY_EXCEEDED');

    const notMine = await quote(other.token, [{ productId: product.amox500, quantity: 1, prescriptionItemId: amox }]);
    expect(notMine.status).toBe(404);
  });

  it('a doctor cannot change items once a pharmacy has dispensed them', async () => {
    const patient = await createUser({ country: 'NG', currency: 'NGN' });
    const { appointmentId, prescription } = await prescribe(patient.id);
    const checkout = await as(patient.token)
      .post('/orders/checkout', {
        items: [{ productId: product.para, quantity: 1, prescriptionItemId: line(prescription, 'Paracetamol') }],
        location: HERE,
        address: '1 Marian Road, Calabar',
      })
      .set('Idempotency-Key', 'rx-lock-checkout');
    expect(checkout.status).toBe(201);
    const edit = await as(doctor.token).patch(`/appointments/${appointmentId}/prescriptions/${prescription.id}`, PRESCRIPTION);
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PRESCRIPTION_DISPENSED');
  });
});

describe('HMO cover for prescribed medicines', () => {
  it('covers prescribed lines only (never delivery), caps at the allowance, pays the pharmacy in full and bills on delivery', async () => {
    const { patient, hmoId } = await hmoPatient();
    const { prescription } = await prescribe(patient.id);
    const items = [
      { productId: product.amox500, quantity: 2, prescriptionItemId: line(prescription, 'Amoxicillin') },
      { productId: product.para, quantity: 1, prescriptionItemId: line(prescription, 'Paracetamol') },
      { productId: product.vitc, quantity: 1 }, // not prescribed: normal price
    ];

    // Prescribed ₦4,500 → 10% co-pay leaves ₦4,050 for the HMO, capped at the ₦4,000 allowance.
    const quote = await as(patient.token).post('/orders/quote', { items, location: HERE });
    expect(quote.status).toBe(200);
    const surcharge = orderSurcharge(1_300, await getFeePolicy());
    expect(quote.body).toMatchObject({ subtotal: 5_300, deliveryFee: 100, hmoAmount: 4_000, surcharge });
    expect(quote.body.amountDue).toBe(1_300 + 100 + surcharge);
    expect(quote.body.orders[0].hmo).toMatchObject({ covered: true, hmoName: 'Avon Healthcare HMO', hmoAmount: 4_000, prescribedAmount: 4_500 });

    const res = await as(patient.token)
      .post('/orders/checkout', { items, location: HERE, address: '1 Marian Road, Calabar' })
      .set('Idempotency-Key', 'rx-hmo-checkout');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ hmoAmount: 4_000, amountDue: 1_300 + 100 + surcharge, status: 'awaiting_payment' });
    const orderId = res.body.orders[0].id;
    const [claim] = await db.select().from(hmoClaims).where(eq(hmoClaims.orderId, orderId));
    expect(claim).toMatchObject({ service: 'medicines', hmoAmount: 4_000, patientAmount: 500, standardAmount: 4_500 });

    // The quantity is now taken: the same medicine can't be ordered again.
    const again = await as(patient.token).post('/orders/quote', { items: [items[0]], location: HERE });
    expect(again.body.error.code).toBe('PRESCRIPTION_QUANTITY_EXCEEDED');

    await db.transaction((tx) => confirmCheckout(tx, res.body.id));
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.pharmacyEarning).toBe(pharmacySplit(5_300, 100).pharmacyEarning); // paid on the full price

    // Not billable until delivered.
    const today = new Date().toISOString().slice(0, 10);
    const early = await as(adminToken).post(`/admin/hmos/${hmoId}/invoices`, { periodStart: today, periodEnd: today });
    expect(early.body.error.code).toBe('NOTHING_TO_INVOICE');

    // The pharmacist sees the prescription on the order and can verify the code.
    const detail = await portal().get(`/pharmacy-portal/orders/${orderId}`);
    expect(detail.body.prescriptions[0]).toMatchObject({ code: prescription.code, doctorName: 'Dr Bola Ade' });
    const verify = await portal().get(`/pharmacy-portal/prescriptions/${prescription.code.toLowerCase()}`);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ patient: { name: 'Ada O.' }, isExpired: false });
    expect(verify.body.items.find((i: { name: string }) => i.name === 'Amoxicillin')).toMatchObject({ remaining: 0 });

    for (const action of [{ action: 'accept', etaMinutes: 30 }, { action: 'dispatch', riderName: 'Musa' }, { action: 'deliver' }])
      expect((await portal().post(`/pharmacy-portal/orders/${orderId}/actions`, action)).status).toBe(200);

    const invoice = await as(adminToken).post(`/admin/hmos/${hmoId}/invoices`, { periodStart: today, periodEnd: today });
    expect(invoice.status).toBe(201);
    expect(invoice.body).toMatchObject({ claimCount: 1, totalAmount: 4_000 });

    const me = await as(patient.token).get('/hmo/me');
    expect(me.body.membership.benefits[0]).toMatchObject({
      label: 'Prescribed medicines',
      allowance: { limit: 4_000, used: 4_000, period: 'year' },
    });
  });

  it('a cancelled covered order refunds only what the patient paid and frees the medicines', async () => {
    const { patient } = await hmoPatient({ coverage: 'full' });
    const { prescription } = await prescribe(patient.id);
    const items = [{ productId: product.amox500, quantity: 2, prescriptionItemId: line(prescription, 'Amoxicillin') }];
    const res = await as(patient.token)
      .post('/orders/checkout', { items, location: HERE, address: '1 Marian Road, Calabar' })
      .set('Idempotency-Key', 'rx-hmo-cancel');
    expect(res.body).toMatchObject({ hmoAmount: 4_000, amountDue: 100 }); // delivery only
    await db.transaction((tx) => confirmCheckout(tx, res.body.id));
    const orderId = res.body.orders[0].id;

    const cancel = await portal().post(`/pharmacy-portal/orders/${orderId}/actions`, { action: 'cancel', reason: 'Out of stock' });
    expect(cancel.status).toBe(200);
    const refunds = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, patient.id));
    expect(refunds.map((r) => Number(r.amount))).toEqual([100]);

    const again = await as(patient.token).post('/orders/quote', { items, location: HERE });
    expect(again.status).toBe(200); // quantity released
  });

  it('confirms at once when nothing is left to pay', async () => {
    await db.update(pharmacies).set({ deliveryFeePerKm: 0 }).where(eq(pharmacies.id, pharmacyId));
    const { patient } = await hmoPatient({ coverage: 'full' });
    const { prescription } = await prescribe(patient.id);
    const res = await as(patient.token)
      .post('/orders/checkout', {
        items: [{ productId: product.para, quantity: 1, prescriptionItemId: line(prescription, 'Paracetamol') }],
        location: HERE,
        address: '1 Marian Road, Calabar',
      })
      .set('Idempotency-Key', 'rx-hmo-free');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', amountDue: 0 });
    const [checkout] = await db.select().from(orderCheckouts).where(eq(orderCheckouts.id, res.body.id));
    expect(checkout!.status).toBe('paid');
    expect(res.body.orders[0].status).toBe('pending');
  });

  it('medicine rules must leave the pharmacy paid in full', async () => {
    const hmo = await as(adminToken).post('/admin/hmos', { name: 'Avon', code: 'avon' });
    const plan = await as(adminToken).post(`/admin/hmos/${hmo.body.id}/plans`, { name: 'Gold' });
    const res = await as(adminToken).post(`/admin/hmos/${hmo.body.id}/plans/${plan.body.plans[0].id}/rules`, {
      service: 'medicines',
      coverage: 'discount_percent',
      percent: 20,
    });
    expect(res.status).toBe(400);
  });
});
