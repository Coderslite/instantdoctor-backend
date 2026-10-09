import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { appSettings, currencies, videoCallCredentials } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';

/** The `app` settings document (Firestore `Settings`). Unknown keys are preserved. */
export const appSettingsSchema = z
  .object({
    trial: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    inappNotice: z.boolean().default(false),
    marquee: z.string().default(''),
    showMarquee: z.boolean().default(false),
    version: z.string().default('1.0.0'),
    versionCode: z.number().int().optional(),
    forceUpdate: z.boolean().default(false),
    trialDoctor: z.string().optional(),
  })
  .loose();

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const SETTINGS_KEYS = {
  app: 'app',
  /** Firestore `AppConfig`: legacy store product prices keyed by product id. */
  productPrices: 'product_prices',
} as const;

const ADDITIONAL_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

export async function getAppSettings(executor: Executor = db): Promise<AppSettings> {
  const [row] = await executor
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, SETTINGS_KEYS.app))
    .limit(1);
  return appSettingsSchema.parse(row?.value ?? {});
}

export async function getTrialDoctorId(executor: Executor = db): Promise<string> {
  const settings = await getAppSettings(executor);
  return settings.trialDoctor?.trim() || env.TRIAL_DOCTOR_ID;
}

export async function listCurrencies() {
  const rows = await db.select({ code: currencies.code }).from(currencies).orderBy(currencies.code);
  return [...new Set([...rows.map(({ code }) => code.toUpperCase()), ...ADDITIONAL_CURRENCIES])]
    .sort()
    .map((code) => ({ code }));
}

export async function isListedCurrency(code: string) {
  return (await listCurrencies()).some((currency) => currency.code === code.toUpperCase());
}

export async function getActiveVideoCallCredentials() {
  const [row] = await db
    .select({ provider: videoCallCredentials.provider, appId: videoCallCredentials.appId, appSign: videoCallCredentials.appSign })
    .from(videoCallCredentials)
    .where(eq(videoCallCredentials.inUse, true))
    .limit(1);
  if (!row) throw notFound('Video call configuration');
  return row;
}
