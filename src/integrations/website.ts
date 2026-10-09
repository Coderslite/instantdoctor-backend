import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Asks the public website (instantdoctor_web) to drop its cached blog data so
 * an admin change shows up immediately instead of when its cache expires.
 * Best effort: disabled without WEBSITE_REVALIDATE_SECRET, never throws.
 */
export function refreshWebsiteBlog(): void {
  if (!env.WEBSITE_REVALIDATE_SECRET) return;
  fetch(`${env.WEBSITE_URL.replace(/\/+$/, '')}/api/revalidate`, {
    method: 'POST',
    headers: { 'x-revalidate-secret': env.WEBSITE_REVALIDATE_SECRET },
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => {
      if (!res.ok) logger.warn({ status: res.status }, 'Website blog refresh was rejected');
    })
    .catch((err: unknown) => logger.warn({ err }, 'Website blog refresh failed'));
}
