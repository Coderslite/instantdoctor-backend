import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Client for the existing mail service (instantdoctorapi `/mail/*`). Email
 * templates and SMTP live there; this service only triggers them. Best-effort.
 */
async function post(path: string, body: Record<string, string>) {
  if (!env.MAIL_SERVICE_URL) return;
  try {
    const res = await fetch(`${env.MAIL_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ path, status: res.status }, 'Mail service returned an error');
  } catch (err) {
    logger.warn({ err, path }, 'Mail service unreachable');
  }
}

export const mailer = {
  welcome: (email: string) => post('/mail/welcome', { email }),
  otp: (email: string, otp: string) => post('/mail/otp', { email, otp }),
  /** Internal "a user did X" notification to the operations team. */
  activity: (userId: string, activityName: string) =>
    post('/mail/activity_notify', { userId, activityName }),
  loginNotice: (email: string, deviceId: string, location: string) =>
    post('/mail/login_notify', { email, deviceId, location }),
  orderReceived: (input: {
    pharmacyEmail: string;
    orderId: string;
    orderDetails: string;
    customerName: string;
  }) => post('/mail/order_received', input),
};
