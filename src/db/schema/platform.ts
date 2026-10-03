import { bigint, boolean, json, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { id, money, updatedAt } from '../columns.js';

/**
 * Key/value application settings (Firestore `Settings` + `AppConfig`).
 * Known keys are typed in `modules/settings/settings.service.ts`.
 */
export const appSettings = mysqlTable('app_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: json('value').notNull(),
  updatedAt: updatedAt(),
});

export const currencies = mysqlTable(
  'currencies',
  {
    id: id('id').primaryKey(),
    code: varchar('code', { length: 3 }).notNull(),
  },
  (t) => [uniqueIndex('currencies_code_uq').on(t.code)],
);

/** Flat service fees (Firestore `Charges`), e.g. lab result interpretation. */
export const serviceCharges = mysqlTable(
  'service_charges',
  {
    id: id('id').primaryKey(),
    type: varchar('type', { length: 64 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    /** Base price in USD, converted with the same pricing rules as appointments. */
    amountUsd: money('amount_usd').notNull(),
    /** Legacy NGN price from Firestore `price`; kept for reference. */
    legacyPriceNgn: money('legacy_price_ngn'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('service_charges_type_uq').on(t.type)],
);

export const videoCallCredentials = mysqlTable('video_call_credentials', {
  id: id('id').primaryKey(),
  provider: varchar('provider', { length: 32 }).notNull().default('zegocloud'),
  appId: bigint('app_id', { mode: 'number' }).notNull(),
  appSign: varchar('app_sign', { length: 255 }).notNull(),
  inUse: boolean('in_use').notNull().default(false),
  updatedAt: updatedAt(),
});
