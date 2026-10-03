import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import { db } from '../../src/db/client.js';

const CHUNK = 250;

/**
 * Bulk upsert (INSERT ... ON DUPLICATE KEY UPDATE every column) so the
 * migration can be re-run before cutover as a delta sync. `overrides` replaces
 * the update expression for specific columns (e.g. to preserve credentials).
 */
export async function upsert<T extends MySqlTable>(
  table: T,
  rows: Array<T['$inferInsert']>,
  overrides: Partial<Record<keyof T['$inferInsert'], SQL>> = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = getTableColumns(table);
  const set = Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [
      key,
      (overrides as Record<string, SQL>)[key] ?? sql.raw(`values(\`${column.name}\`)`),
    ]),
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(table)
      .values(rows.slice(i, i + CHUNK) as never)
      .onDuplicateKeyUpdate({ set: set as never });
  }
  return rows.length;
}
