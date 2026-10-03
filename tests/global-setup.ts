import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

/** Migrates the test database once before the suite. */
export default async function setup() {
  const url = process.env.DATABASE_URL ?? 'mysql://root:root@127.0.0.1:8889/instant_doctor_test';
  if (!/_test\b/.test(url)) throw new Error(`Refusing to run tests against non-test database: ${url}`);
  const pool = mysql.createPool({ uri: url, timezone: 'Z' });
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
}
