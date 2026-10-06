import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, db, pool } from '../../src/db/client.js';
import { users } from '../../src/db/schema/index.js';
import { createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

describe('database time', () => {
  it('runs every session in UTC regardless of the server time zone', async () => {
    const [rows] = await pool.query("SELECT @@session.time_zone AS tz, TIMESTAMPDIFF(SECOND, NOW(), UTC_TIMESTAMP()) AS drift");
    expect(rows).toEqual([{ tz: '+00:00', drift: 0 }]);
  });

  it('stores default timestamps in UTC, matching values written by the API', async () => {
    await resetDatabase();
    const before = Date.now();
    const { id } = await createUser();
    const [row] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, id));
    expect(Math.abs(row!.createdAt.getTime() - before)).toBeLessThan(5_000);
  });
});
