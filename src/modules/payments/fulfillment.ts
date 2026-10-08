import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  appointments,
  labResults,
  orderCheckouts,
  orderItems,
  orders,
  pharmacies,
  products,
  referrals,
  users,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { emailAppointmentUpdate } from '../appointments/appointment-emails.js';
import { sendPush, type PushMessage } from '../../integrations/push.js';
import { notFound } from '../../lib/errors.js';
import { realtime } from '../../realtime/gateway.js';
import { doctorPushTokens } from '../doctors/doctors.service.js';
import { activateFamilySubscription } from '../subscriptions/subscriptions.service.js';
import { createNotification } from '../notifications/notifications.service.js';
import { doctorEarning, pharmacySplit, referralCommission } from '../pricing/fees.js';
import { creditReferralBalance, credit } from '../wallet/wallet.ledger.js';
import type { Effect } from './effects.js';

export interface FulfillmentResult {
  effects: Effect[];
  /** True when the target was already fulfilled (e.g. paid twice): needs a refund review. */
  duplicate: boolean;
}

export async function confirmFamilySubscription(tx: Tx, userId: string): Promise<FulfillmentResult> {
  await activateFamilySubscription(tx, userId);
  return {
    effects: [
      await createNotification({ userId, type: 'transaction', title: 'Your Family Care membership is active' }, tx),
      await payerPush(tx, userId, {
        title: 'Payment confirmed',
        body: 'Your Family Care membership is active.',
        data: { type: 'transaction' },
      }),
    ],
    duplicate: false,
  };
}

/**
 * A push to whoever paid, so they learn the payment went through even when
 * the app crashed or was closed during checkout.
 */
async function payerPush(tx: Tx, userId: string, message: PushMessage): Promise<Effect> {
  const [user] = await tx.select({ token: users.fcmToken }).from(users).where(eq(users.id, userId));
  return () => sendPush([user?.token], message);
}

const fmt = (d: Date) =>
  d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';

// ─── Appointments ────────────────────────────────────────────────────────────

/**
 * Marks an appointment as paid/confirmed and applies the booking side effects:
 * doctor earning, first-booking referral commission, user notification and
 * doctor alerts. Used for both paid bookings and free trials.
 */
export async function confirmAppointment(
  tx: Tx,
  appointmentId: string,
  opts: { currency?: string } = {},
): Promise<FulfillmentResult> {
  const [appointment] = await tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .for('update');
  if (!appointment) throw notFound('Appointment');
  if (appointment.isPaid && !appointment.isTrial) return { effects: [], duplicate: true };

  const now = new Date();
  await tx
    .update(appointments)
    .set({
      isPaid: true,
      paidAt: appointment.paidAt ?? now,
      currency: opts.currency ?? appointment.currency,
      doctorEarning: appointment.isTrial
        ? 0
        : appointment.isSubscriptionCredit
          ? appointment.doctorEarning
          : doctorEarning(appointment.price),
    })
    .where(eq(appointments.id, appointmentId));
  await tx.update(users).set({ hasPaid: true }).where(eq(users.id, appointment.userId));

  const effects: Effect[] = [];

  // Referral commission on the referred user's first paid booking.
  const [prior] = await tx
    .select({ n: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.userId, appointment.userId),
        eq(appointments.isPaid, true),
        ne(appointments.id, appointmentId),
      ),
    );
  if ((prior?.n ?? 0) === 0 && appointment.price > 0) {
    effects.push(...(await awardReferralCommission(tx, appointment.userId, appointment.price, appointment.currency)));
  }

  effects.push(
    await createNotification(
      {
        userId: appointment.userId,
        type: 'appointment',
        title: `You have successfully scheduled an appointment ${fmt(appointment.startTime)} - ${fmt(appointment.endTime)}`,
        uniqueId: appointment.id,
      },
      tx,
    ),
  );

  if (!appointment.isTrial && !appointment.isSubscriptionCredit && appointment.price > 0) {
    effects.push(
      await payerPush(tx, appointment.userId, {
        title: 'Payment confirmed',
        body: `Your consultation on ${fmt(appointment.startTime)} is booked.`,
        data: { id: appointment.id, type: 'appointment' },
      }),
    );
  }

  // Addressed bookings alert their doctor; open requests alert every doctor (first to accept wins).
  const tokens = await doctorPushTokens(tx, appointment.doctorId ?? undefined);
  effects.push(
    () =>
      sendPush(tokens, {
        title: 'New Appointment',
        body: 'A new appointment has been scheduled, kindly accept it.',
        data: { id: appointment.id, type: 'appointment' },
      }),
    () =>
      realtime.toUser(appointment.userId, 'appointment:updated', {
        id: appointment.id,
        status: appointment.status,
        isPaid: true,
      }),
    () => mailer.activity(appointment.userId, 'Appointment'),
    () => emailAppointmentUpdate(appointment.id, 'confirmed'),
  );

  return { effects, duplicate: false };
}

async function awardReferralCommission(
  tx: Tx,
  referredUserId: string,
  amount: number,
  currency: string | null,
): Promise<Effect[]> {
  const [referral] = await tx
    .select()
    .from(referrals)
    .where(and(eq(referrals.userId, referredUserId), eq(referrals.status, 'active')))
    .for('update');
  if (!referral?.referrerId) return [];
  // Commission is paid once per referred user. The row is locked, so this check is
  // race-free even if two of the user's bookings are paid concurrently.
  if (referral.lastCommissionAt) return [];

  const commission = referralCommission(amount);
  if (commission <= 0) return [];

  await tx
    .update(referrals)
    .set({
      totalCommissionEarned: sql`${referrals.totalCommissionEarned} + ${commission}`,
      lastCommissionAt: new Date(),
    })
    .where(eq(referrals.id, referral.id));
  await creditReferralBalance(tx, referral.referrerId, commission);

  const [referred] = await tx.select({ firstName: users.firstName }).from(users).where(eq(users.id, referredUserId));
  const notify = await createNotification(
    {
      userId: referral.referrerId,
      type: 'transaction',
      title: `You earned ${currency ?? ''} ${commission.toFixed(2)} from ${referred?.firstName || 'a referred user'}'s appointment booking`.trim(),
    },
    tx,
  );
  return [notify];
}

// ─── Pharmacy orders ─────────────────────────────────────────────────────────

export async function confirmCheckout(tx: Tx, checkoutId: string): Promise<FulfillmentResult> {
  const [checkout] = await tx.select().from(orderCheckouts).where(eq(orderCheckouts.id, checkoutId)).for('update');
  if (!checkout) throw notFound('Checkout');
  if (checkout.status === 'paid') return { effects: [], duplicate: true };

  await tx.update(orderCheckouts).set({ status: 'paid' }).where(eq(orderCheckouts.id, checkoutId));

  const checkoutOrders = await tx.select().from(orders).where(eq(orders.checkoutId, checkoutId));
  const items = checkoutOrders.length
    ? await tx.select().from(orderItems).where(inArray(orderItems.orderId, checkoutOrders.map((o) => o.id)))
    : [];

  for (const order of checkoutOrders) {
    const split = pharmacySplit(order.subtotal, order.deliveryFee);
    await tx
      .update(orders)
      .set({ status: 'pending', pharmacyEarning: split.pharmacyEarning, platformEarning: split.platformEarning })
      .where(eq(orders.id, order.id));
  }
  for (const item of items) {
    if (!item.productId) continue;
    await tx
      .update(products)
      .set({ stockRemaining: sql`GREATEST(${products.stockRemaining} - ${item.quantity}, 0)` })
      .where(eq(products.id, item.productId));
  }

  const effects: Effect[] = [
    await createNotification({ userId: checkout.userId, type: 'transaction', title: 'Your purchase was successful' }, tx),
    await payerPush(tx, checkout.userId, {
      title: 'Payment confirmed',
      body: 'Your order has been sent to the pharmacy.',
      data: { type: 'transaction' },
    }),
    () => mailer.activity(checkout.userId, 'Order'),
  ];

  const [customer] = await tx
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, checkout.userId));
  const pharmacyRows = checkoutOrders.length
    ? await tx
        .select({ id: pharmacies.id, email: pharmacies.email, name: pharmacies.name })
        .from(pharmacies)
        .where(inArray(pharmacies.id, checkoutOrders.map((o) => o.pharmacyId)))
    : [];
  const pharmacyById = new Map(pharmacyRows.map((p) => [p.id, p]));
  const customerName = `${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`.trim() || 'A customer';

  for (const order of checkoutOrders) {
    const pharmacy = pharmacyById.get(order.pharmacyId);
    if (!pharmacy?.email) continue;
    const lines = items
      .filter((i) => i.orderId === order.id)
      .map((i) => ({ name: i.name, quantity: i.quantity }));
    effects.push(() =>
      mailer.pharmacyNewOrder({
        to: pharmacy.email,
        pharmacyName: pharmacy.name,
        trackingId: order.trackingId,
        customerName,
        items: lines,
        deliveryAddress: order.address,
      }),
    );
  }

  return { effects, duplicate: false };
}

// ─── Lab results ─────────────────────────────────────────────────────────────

export async function confirmLabResult(tx: Tx, labResultId: string): Promise<FulfillmentResult> {
  const [result] = await tx.select().from(labResults).where(eq(labResults.id, labResultId)).for('update');
  if (!result) throw notFound('Lab result');
  if (result.status !== 'awaiting_payment') return { effects: [], duplicate: true };
  await tx.update(labResults).set({ status: 'pending' }).where(eq(labResults.id, labResultId));
  return {
    effects: [
      await createNotification(
        { userId: result.userId, type: 'lab_result', title: 'Payment received. A doctor will review your lab result shortly', uniqueId: labResultId },
        tx,
      ),
      await payerPush(tx, result.userId, {
        title: 'Payment confirmed',
        body: 'A doctor will review your lab result shortly.',
        data: { id: labResultId, type: 'lab_result' },
      }),
      () => mailer.activity(result.userId, 'Lab Result'),
    ],
    duplicate: false,
  };
}

// ─── Wallet top-up ───────────────────────────────────────────────────────────

export async function confirmWalletTopUp(
  tx: Tx,
  payment: { id: string; userId: string; baseAmount: number; currency: string },
): Promise<FulfillmentResult> {
  const balance = await credit(tx, {
    userId: payment.userId,
    amount: payment.baseAmount,
    title: 'Wallet Top Up',
    paymentId: payment.id,
  });
  const [user] = await tx.select({ token: users.fcmToken }).from(users).where(eq(users.id, payment.userId));
  const amountText = `${payment.currency} ${payment.baseAmount.toLocaleString('en-US')}`;
  return {
    duplicate: false,
    effects: [
      await createNotification(
        { userId: payment.userId, type: 'transaction', title: `Your top up of ${amountText} was successful` },
        tx,
      ),
      () =>
        sendPush([user?.token], {
          title: 'Top-up Successful',
          body: `You have successfully topped up ${amountText}. New balance: ${payment.currency} ${balance.toLocaleString('en-US')}`,
          data: { type: 'transaction' },
        }),
    ],
  };
}
