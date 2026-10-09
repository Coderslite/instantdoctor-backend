import { createServer } from 'node:http';
import { env } from './config/env.js';
import { closeDatabase, databaseLabel } from './db/client.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { purgeExpiredIdempotencyKeys } from './middleware/idempotency.js';
import { purgeAbandonedUploads, purgeUnclaimedApplicantFiles } from './modules/files/files.service.js';
import { reconcilePendingPayments } from './modules/payments/payments.service.js';
import { closeRealtime, initRealtime } from './realtime/gateway.js';

const app = createApp();
const server = createServer(app);
initRealtime(server);

server.listen(env.PORT, () =>
  logger.info(
    { port: env.PORT, env: env.NODE_ENV, database: databaseLabel },
    'Instant Doctor API listening',
  ),
);

const housekeeping = setInterval(
  () => {
    purgeExpiredIdempotencyKeys()
      .then((n) => n > 0 && logger.info({ purged: n }, 'Expired idempotency keys purged'))
      .catch((err: unknown) => logger.error({ err }, 'Idempotency purge failed'));
    purgeAbandonedUploads()
      .then((n) => n > 0 && logger.info({ purged: n }, 'Abandoned uploads purged'))
      .catch((err: unknown) => logger.error({ err }, 'Upload purge failed'));
    purgeUnclaimedApplicantFiles()
      .then((n) => n > 0 && logger.info({ purged: n }, 'Unclaimed applicant documents purged'))
      .catch((err: unknown) => logger.error({ err }, 'Applicant document purge failed'));
  },
  60 * 60 * 1000,
);
housekeeping.unref();

// Settles payments whose webhook never arrived (see reconcilePendingPayments).
let reconciling = false;
const reconcilePayments = () => {
  if (reconciling) return;
  reconciling = true;
  reconcilePendingPayments()
    .then((s) => (s.succeeded > 0 || s.errors > 0) && logger.info(s, 'Pending payments reconciled'))
    .catch((err: unknown) => logger.error({ err }, 'Payment reconciliation failed'))
    .finally(() => (reconciling = false));
};
const paymentSweep = setInterval(reconcilePayments, 10 * 60 * 1000);
paymentSweep.unref();
setTimeout(reconcilePayments, 60 * 1000).unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  clearInterval(housekeeping);
  clearInterval(paymentSweep);
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
