import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseConfig } from './src/config/database.js';

// `generate` needs no connection; studio/introspection use the selected DB_TARGET.
const db = (() => {
  try {
    return resolveDatabaseConfig();
  } catch {
    return null;
  }
})();

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: db
    ? { host: db.host, port: db.port, user: db.user, password: db.password, database: db.database, ssl: db.ssl }
    : { url: 'mysql://unset@localhost/unset' },
  // Only manage tables this service owns; leave pre-existing tables (e.g. `campaigns`) alone.
  tablesFilter: ['!campaigns'],
  strict: true,
  verbose: true,
});
