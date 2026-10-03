import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { describeDatabase, resolveDatabaseConfig } from '../config/database.js';
import * as schema from './schema/index.js';

export const databaseConfig = resolveDatabaseConfig();
export const databaseLabel = describeDatabase(databaseConfig);

export const pool = mysql.createPool({
  host: databaseConfig.host,
  port: databaseConfig.port,
  user: databaseConfig.user,
  password: databaseConfig.password,
  database: databaseConfig.database,
  ssl: databaseConfig.ssl,
  connectionLimit: databaseConfig.poolSize,
  // Cloud databases (TiDB Serverless) close idle connections; keep them alive
  // and recycle idle ones before the server drops them.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  maxIdle: databaseConfig.poolSize,
  idleTimeout: 60_000,
  // Store and read every DATETIME as UTC regardless of server/host time zone.
  timezone: 'Z',
  dateStrings: false,
  decimalNumbers: true,
  charset: 'utf8mb4_unicode_ci',
});

export const db = drizzle(pool, { schema, mode: 'default' });

export type Database = MySql2Database<typeof schema>;
/** A transaction handle, structurally compatible with `db` for queries. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed `db` or an open transaction. */
export type Executor = Database | Tx;

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
