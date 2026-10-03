import { createServer } from 'node:http';
import { env } from './config/env.js';
import { closeDatabase, databaseLabel } from './db/client.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { purgeExpiredIdempotencyKeys } from './middleware/idempotency.js';
import { closeRealtime, initRealtime } from './realtime/gateway.js';

const app = createApp();
const server = createServer(app);
initRealtime(server);

server.listen(env.PORT, () =>
  logger.info({ port: env.PORT, env: env.NODE_ENV, database: databaseLabel }, 'Instant Doctor API listening'),
);

const housekeeping = setInterval(() => {
  purgeExpiredIdempotencyKeys()
    .then((n) => n > 0 && logger.info({ purged: n }, 'Expired idempotency keys purged'))
    .catch((err: unknown) => logger.error({ err }, 'Idempotency purge failed'));
}, 60 * 60 * 1000);
housekeeping.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(housekeeping);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close();
  await closeRealtime();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
