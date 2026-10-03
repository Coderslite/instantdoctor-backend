import { logger } from '../../lib/logger.js';

/**
 * A side effect (push, email, socket emit) to run only after the surrounding
 * transaction commits. Failures are logged and never undo the committed work.
 */
export type Effect = () => unknown;

export async function runEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (err) {
      logger.error({ err }, 'Post-commit effect failed');
    }
  }
}
