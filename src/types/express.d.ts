import type { AdminRole, UserRole } from '../db/schema/users.js';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: UserRole };
      adminAuth?: { adminId: string; role: AdminRole };
      pharmacyAuth?: {
        pharmacyId: string;
        staffId?: string;
        role: 'owner' | 'manager' | 'pharmacist' | 'inventory_officer' | 'sales_assistant';
        mustChangePassword?: boolean;
      };
      /** Validated Idempotency-Key, set by the `idempotent()` middleware. */
      idempotencyKey?: string;
    }
  }
}

export {};
