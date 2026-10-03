import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
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
  const valid = [...new Set(tokens.filter((t): t is string => Boolean(t && t.trim())))];
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
