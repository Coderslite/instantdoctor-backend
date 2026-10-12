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
  /**
   * Each day's earnings clear together: an order delivered any time on a Lagos
   * day can be withdrawn from this hour on the following day.
   */
  clearingHour: z.number().int().min(0).max(23).default(6),
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
  // Earnings still waiting move to the new clearing time (Lagos is UTC+1, so its date is created_at + 1h).
  if (value.clearingHour !== previous.clearingHour) {
    await db
      .update(pharmacyLedger)
      .set({ availableAt: sql`date_add(date_add(date(date_add(${pharmacyLedger.createdAt}, interval 1 hour)), interval 1 day), interval ${value.clearingHour - 1} hour)` })
      .where(and(eq(pharmacyLedger.type, 'order_earning'), gt(pharmacyLedger.availableAt, sql`utc_timestamp(3)`)));
  }
  return value;
}

/** Nigeria has no daylight saving: Lagos is UTC+1 all year. */
const LAGOS_OFFSET_MS = 3600_000;

/** When money earned at `at` can be withdrawn: `hour` o'clock (Lagos) on the next Lagos day. */
export function clearingTime(at: Date, hour: number) {
  const lagos = new Date(at.getTime() + LAGOS_OFFSET_MS);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate() + 1, hour) - LAGOS_OFFSET_MS);
}

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
