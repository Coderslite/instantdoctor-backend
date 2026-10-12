import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../../db/client.js';
import { appSettings, pharmacyLedger } from '../../db/schema/index.js';

const KEY = 'pharmacy_payouts';

export const payoutSettingsSchema = z.object({
  /** Pay out whatever is available each week, for pharmacies that didn't withdraw. */
  weeklyEnabled: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday, in Africa/Lagos time. */
  weekday: z.number().int().min(0).max(6).default(1),
  hour: z.number().int().min(0).max(23).default(9),
  /** Hours a delivered order's earning waits before it can be withdrawn (time to raise a problem). 0 = on delivery. */
  clearingHours: z.number().int().min(0).max(24 * 30).default(24),
  /** Send weekly payouts without an admin approving each one. */
  autoApproveScheduled: z.boolean().default(false),
});
export type PayoutSettings = z.infer<typeof payoutSettingsSchema>;

export async function getPayoutSettings(executor: Tx | typeof db = db): Promise<PayoutSettings> {
  const [row] = await executor.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  return payoutSettingsSchema.parse(row?.value ?? {});
}

export async function savePayoutSettings(input: Partial<PayoutSettings>) {
  const previous = await getPayoutSettings();
  const value = payoutSettingsSchema.parse({ ...previous, ...input });
  await db.insert(appSettings).values({ key: KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  // A shorter clearing period also frees earnings already waiting under the old one.
  if (value.clearingHours < previous.clearingHours) {
    await db
      .update(pharmacyLedger)
      .set({ availableAt: sql`least(${pharmacyLedger.availableAt}, date_add(${pharmacyLedger.createdAt}, interval ${value.clearingHours} hour))` })
      .where(and(eq(pharmacyLedger.type, 'order_earning'), gt(pharmacyLedger.availableAt, sql`utc_timestamp(3)`)));
  }
  return value;
}

/** Nigeria has no daylight saving: Lagos is UTC+1 all year. */
const LAGOS_OFFSET_MS = 3600_000;

/** This week's scheduled moment (UTC) and a stable key for the week it belongs to. */
export function scheduledSlot(settings: Pick<PayoutSettings, 'weekday' | 'hour'>, now = new Date()) {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const daysBack = (lagos.getUTCDay() - settings.weekday + 7) % 7;
  const slot = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() - daysBack, settings.hour) - LAGOS_OFFSET_MS);
  // Before this week's time on the day itself: the current slot is last week's.
  const current = slot.getTime() > now.getTime() ? new Date(slot.getTime() - 7 * 86_400_000) : slot;
  const next = new Date(current.getTime() + 7 * 86_400_000);
  return { current, next, key: `weekly:${current.toISOString().slice(0, 13)}` };
}
