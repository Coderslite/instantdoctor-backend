import { sql } from 'drizzle-orm';
import { customType, datetime, decimal } from 'drizzle-orm/mysql-core';

/**
 * Primary/foreign key column. Firestore document IDs are case-sensitive
 * ("abc" and "ABC" are different documents), so IDs use a binary collation.
 * 36 chars fits both legacy Firestore IDs (20–28 chars) and UUIDs.
 */
export const id = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'varchar(36) CHARACTER SET ascii COLLATE ascii_bin';
  },
});

/** Monetary amount in major units (e.g. 6800.00 NGN, 9.99 USD). */
export const money = (name: string) => decimal(name, { precision: 14, scale: 2, mode: 'number' });

/** FX multiplier with enough precision for currencies with very small USD rates. */
export const exchangeRate = (name: string) => decimal(name, { precision: 18, scale: 8, mode: 'number' });

/** Latitude/longitude with ~1cm precision. */
export const coordinate = (name: string) =>
  decimal(name, { precision: 10, scale: 7, mode: 'number' });

/** UTC timestamp with millisecond precision. */
export const timestamp = (name: string) => datetime(name, { mode: 'date', fsp: 3 });

export const createdAt = () =>
  timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`);

export const updatedAt = () =>
  timestamp('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date());
