import { getMessaging } from 'firebase-admin/messaging';
import { and, eq, inArray } from 'drizzle-orm';
import { databaseConfig, db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { env, isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getFirebaseApp } from './firebase.js';

export interface PushMessage {
  title: string;
  body: string;
  /** String-only data payload delivered to the app (e.g. `{ id, type }`). */
  data?: Record<string, string>;
}

/**
 * Sends a push notification to FCM tokens. Best-effort: failures are logged,
 * never thrown, so they cannot roll back the business operation that triggered them.
 */
export async function sendPush(tokens: Array<string | null | undefined>, message: PushMessage) {
  let valid = [...new Set(tokens.filter((t): t is string => Boolean(t && t.trim())))];
  // A local database is used for testing. Do not alert real doctors from it;
  // keep one explicit test recipient so the full FCM flow remains testable.
  if ((isTest || databaseConfig.target === 'local') && valid.length > 0) {
    const recipients = await db
      .select({ token: users.fcmToken })
      .from(users)
      .where(
        and(
          inArray(users.fcmToken, valid),
          eq(users.role, 'doctor'),
          eq(users.email, env.TEST_DOCTOR_PUSH_EMAIL),
        ),
      );
    const permittedDoctorTokens = new Set(recipients.map((recipient) => recipient.token));
    const doctorTokens = await db
      .select({ token: users.fcmToken })
      .from(users)
      .where(and(inArray(users.fcmToken, valid), eq(users.role, 'doctor')));
    const allDoctorTokens = new Set(doctorTokens.map((doctor) => doctor.token));
    valid = valid.filter((token) => !allDoctorTokens.has(token) || permittedDoctorTokens.has(token));
  }
  if (!env.ENABLE_PUSH || valid.length === 0) return;
  const app = getFirebaseApp();
  if (!app) {
    logger.warn('Push skipped: FIREBASE_SERVICE_ACCOUNT_PATH is not configured');
    return;
  }
  try {
    const result = await getMessaging(app).sendEachForMulticast({
      tokens: valid,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    if (result.failureCount > 0) {
      logger.warn({ failures: result.failureCount, sent: result.successCount }, 'Some pushes failed');
    }
  } catch (err) {
    logger.error({ err }, 'Push notification failed');
  }
}
