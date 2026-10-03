import type { UserRole } from '../db/schema/users.js';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: UserRole };
      /** Validated Idempotency-Key, set by the `idempotent()` middleware. */
      idempotencyKey?: string;
    }
  }
}

export {};
