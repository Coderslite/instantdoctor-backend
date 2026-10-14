import { and, eq, gt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { appSettings, doctorLedger } from '../../db/schema/index.js';
import { payoutSettingsSchema, type PayoutSettings } from '../payouts/payouts.settings.js';

/** Doctor payouts run on the same kind of weekly schedule as pharmacy payouts, configured separately. */
const KEY = 'doctor_payouts';

export async function getDoctorPayoutSettings(executor: Tx | typeof db = db): Promise<PayoutSettings> {
  const [row] = await executor.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
  return payoutSettingsSchema.parse(row?.value ?? {});
}

export async function saveDoctorPayoutSettings(input: Partial<PayoutSettings>) {
  const previous = await getDoctorPayoutSettings();
  const value = payoutSettingsSchema.parse({ ...previous, ...input });
  await db.insert(appSettings).values({ key: KEY, value }).onDuplicateKeyUpdate({ set: { value } });
  // Earnings still clearing move to the new clearing time (Lagos is UTC+1).
  if (value.clearingHour !== previous.clearingHour) {
    await db
      .update(doctorLedger)
      .set({ availableAt: sql`date_add(date_add(date(date_add(${doctorLedger.createdAt}, interval 1 hour)), interval 1 day), interval ${value.clearingHour - 1} hour)` })
      .where(and(eq(doctorLedger.type, 'earning'), gt(doctorLedger.availableAt, sql`utc_timestamp(3)`)));
  }
  return value;
}
