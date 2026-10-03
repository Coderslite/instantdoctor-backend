import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { env } from '../config/env.js';

let app: App | null | undefined;

/** Lazily initialised Firebase Admin app, or null when no service account is configured. */
export function getFirebaseApp(): App | null {
  if (app !== undefined) return app;
  if (!env.FIREBASE_SERVICE_ACCOUNT_PATH) return (app = null);
  const credentials = JSON.parse(
    readFileSync(resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH), 'utf8'),
  ) as Record<string, string>;
  app = getApps()[0] ?? initializeApp({ credential: cert(credentials) });
  return app;
}
