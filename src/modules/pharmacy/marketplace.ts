import { eq } from 'drizzle-orm';
import type { db, Tx } from '../../db/client.js';
import {
  orderEvents,
  orderItems,
  orders,
  pharmacies,
  users,
  WEEKDAYS,
  type OpeningHours,
  type Weekday,
} from '../../db/schema/index.js';
import { sendPush } from '../../integrations/push.js';
import { mailer } from '../../integrations/mailer.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { createNotification } from '../notifications/notifications.service.js';
import type { Effect } from '../payments/effects.js';

type Pharmacy = typeof pharmacies.$inferSelect;

// ─── Opening hours ───────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isValidTime = (t: string) => HHMM.test(t);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** "20:00" → "8:00 PM". */
export function displayTime(t: string): string {
  const m = minutes(t);
  const h = Math.floor(m / 60);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m % 60).padStart(2, '0')} ${suffix}`;
}

const DAY_NAMES: Record<Weekday, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** Weekday and minutes-past-midnight at [now] in [timeZone]. */
function localClock(now: Date, timeZone: string): { day: number; minute: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localClock(now, 'Africa/Lagos');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday'));
  return { day: Math.max(0, day), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export interface StoreStatus {
  /** Can take an order right now. */
  open: boolean;
  /** 'open' | 'closed' (outside hours) | 'paused' (switched off) | 'offline' (not live). */
  state: 'open' | 'closed' | 'paused' | 'offline';
  /** Short customer-facing label, e.g. "Open · until 8:00 PM", "Opens Tue 8:00 AM". */
  label: string;
}

/**
 * Whether a pharmacy can take orders at [now]: it must be live, switched on,
 * and inside its opening hours (no hours set = always open). Handles
 * overnight hours such as 20:00–02:00.
 */
export function storeStatus(
  p: Pick<Pharmacy, 'status' | 'acceptingOrders' | 'openingHours' | 'timeZone'>,
  now = new Date(),
): StoreStatus {
  if (p.status !== 'active') return { open: false, state: 'offline', label: 'Not available' };
  if (!p.acceptingOrders) return { open: false, state: 'paused', label: 'Not taking orders right now' };
  const hours = p.openingHours;
  if (!hours || WEEKDAYS.every((d) => !hours[d])) return { open: true, state: 'open', label: 'Open' };

  const { day, minute } = localClock(now, p.timeZone || 'Africa/Lagos');
  const today = hours[WEEKDAYS[day]!];
  const yesterday = hours[WEEKDAYS[(day + 6) % 7]!];

  if (today) {
    const o = minutes(today.open);
    const c = minutes(today.close);
    const overnight = c <= o;
    if ((!overnight && minute >= o && minute < c) || (overnight && minute >= o)) {
      return { open: true, state: 'open', label: `Open · until ${displayTime(today.close)}` };
    }
  }
  if (yesterday) {
    const o = minutes(yesterday.open);
    const c = minutes(yesterday.close);
    if (c <= o && minute < c) {
      return { open: true, state: 'open', label: `Open · until ${displayTime(yesterday.close)}` };
    }
  }

  // Next opening within the coming week.
  for (let ahead = 0; ahead < 7; ahead++) {
    const d = (day + ahead) % 7;
    const entry = hours[WEEKDAYS[d]!];
    if (!entry) continue;
    if (ahead === 0 && minutes(entry.open) <= minute) continue;
    const when = ahead === 0 ? '' : ahead === 1 ? 'tomorrow ' : `${DAY_NAMES[WEEKDAYS[d]!]} `;
    return { open: false, state: 'closed', label: `Closed · opens ${when}${displayTime(entry.open)}` };
  }
  return { open: false, state: 'closed', label: 'Closed' };
}

/** Validates hours from a form: HH:mm times, open ≠ close. */
export function cleanOpeningHours(input: OpeningHours): OpeningHours {
  const out: OpeningHours = {};
  for (const d of WEEKDAYS) {
    const e = input[d];
    if (!e) {
      out[d] = null;
      continue;
    }
    if (!isValidTime(e.open) || !isValidTime(e.close) || e.open === e.close) {
      throw new Error(`Invalid hours for ${DAY_NAMES[d]}`);
    }
    out[d] = { open: e.open, close: e.close };
  }
  return out;
}

// ─── Go-live checklist ───────────────────────────────────────────────────────

export interface SetupItem {
  key: string;
  label: string;
  hint: string;
  done: boolean;
}

/** What a pharmacy must finish before customers can see and order from it. */
export function setupChecklist(p: Pharmacy, activeProducts: number): SetupItem[] {
  const hours = p.openingHours;
  return [
    {
      key: 'logo',
      label: 'Profile image',
      hint: 'A square logo or photo customers recognise.',
      done: Boolean(p.image),
    },
    {
      key: 'cover',
      label: 'Cover image',
      hint: 'A wide photo of your storefront for your store page.',
      done: Boolean(p.coverImage),
    },
    {
      key: 'contact',
      label: 'Phone number',
      hint: 'So customers and riders can reach you about an order.',
      done: Boolean(p.phoneNumber?.trim()),
    },
    {
      key: 'location',
      label: 'Address and map location',
      hint: 'Used to show you to nearby customers and price delivery.',
      done: Boolean(p.address?.trim() && p.latitude !== null && p.longitude !== null),
    },
    {
      key: 'hours',
      label: 'Opening hours',
      hint: 'When you take orders. Customers can’t order while you’re closed.',
      done: Boolean(hours && WEEKDAYS.some((d) => hours[d])),
    },
    {
      key: 'products',
      label: 'At least one product in stock',
      hint: 'Add your catalogue from Inventory.',
      done: activeProducts > 0,
    },
  ];
}

export const setupComplete = (items: SetupItem[]) => items.every((i) => i.done);

export const averageRating = (p: Pick<Pharmacy, 'ratingTotal' | 'ratingCount'>) =>
  p.ratingCount > 0 ? Math.round((p.ratingTotal / p.ratingCount) * 10) / 10 : null;

// ─── Order timeline and customer updates ─────────────────────────────────────

export type OrderActor = 'system' | 'pharmacy' | 'customer';

export async function recordOrderEvent(
  executor: Tx | typeof db,
  orderId: string,
  status: string,
  actor: OrderActor,
  note?: string | null,
) {
  await executor.insert(orderEvents).values({ id: newId(), orderId, status, actor, note: note ?? null });
}

const PUSH_COPY: Record<string, { title: string; body: (ctx: PushContext) => string }> = {
  processing: {
    title: 'Order accepted',
    body: (c) => `${c.pharmacy} is preparing your order${c.eta ? ` · arriving in about ${c.eta} min` : ''}.`,
  },
  delivering: {
    title: 'Your order is on the way',
    body: (c) => (c.rider ? `${c.rider} from ${c.pharmacy} is bringing your order.` : `${c.pharmacy} sent out your order.`),
  },
  completed: { title: 'Order delivered', body: (c) => `Delivered by ${c.pharmacy}. Tap to rate your experience.` },
  cancelled: {
    title: 'Order cancelled',
    body: (c) => `${c.pharmacy} couldn’t fulfil your order${c.reason ? `: ${c.reason}` : ''}. You’ve been refunded.`,
  },
};

interface PushContext {
  pharmacy: string;
  eta?: number | null;
  rider?: string | null;
  reason?: string | null;
}

/**
 * Effects that tell the customer about an order's new status: in-app
 * notification (inside [tx]), then push and email after commit.
 */
export async function customerOrderUpdate(
  tx: Tx,
  orderId: string,
  status: string,
  extra: { note?: string | null } = {},
): Promise<Effect[]> {
  const copy = PUSH_COPY[status];
  if (!copy) return [];
  const [row] = await tx
    .select({
      order: orders,
      pharmacyName: pharmacies.name,
      email: users.email,
      firstName: users.firstName,
      token: users.fcmToken,
    })
    .from(orders)
    .innerJoin(pharmacies, eq(pharmacies.id, orders.pharmacyId))
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return [];
  const o = row.order;
  const body = copy.body({
    pharmacy: row.pharmacyName,
    eta: o.etaMinutes,
    rider: o.riderName,
    reason: o.cancelReason,
  });
  const notify = await createNotification(
    { userId: o.userId, type: 'transaction', title: `${copy.title} · ${o.trackingId}` },
    tx,
  );
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  return [
    notify,
    () =>
      sendPush([row.token], {
        title: copy.title,
        body,
        data: { type: 'order', id: orderId, status },
      }),
    async () => {
      try {
        await mailer.orderStatusUpdate({
          to: row.email,
          firstName: row.firstName,
          trackingId: o.trackingId,
          status,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
          total: formatNaira(o.totalAmount),
          pharmacyName: row.pharmacyName,
          note: extra.note ?? body,
        });
      } catch (err) {
        logger.error({ err, orderId, status }, 'Failed to send order status email');
      }
    },
  ];
}

export const formatNaira = (amount: number) =>
  new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 2 }).format(amount);
