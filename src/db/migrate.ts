import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import { resolveDatabaseConfig } from '../config/database.js';
import { logger } from '../lib/logger.js';

/** New TiDB Cloud clusters only have a `test` database; create ours on first run. */
async function ensureDatabase() {
  const cfg = resolveDatabaseConfig();
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database.replaceAll('`', '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await conn.end();
  }
}

async function main() {
  await ensureDatabase();
  // Import after the database exists: the client's pool connects to it.
  const { closeDatabase, databaseLabel, db } = await import('./client.js');
  try {
    logger.info({ database: databaseLabel }, 'Applying database migrations');
    await migrate(db, { migrationsFolder: './drizzle' });
    logger.info({ database: databaseLabel }, 'Migrations applied');
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'Migration failed');
  process.exitCode = 1;
});
