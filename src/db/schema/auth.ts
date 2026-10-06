import { index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, timestamp } from '../columns.js';
import { users } from './users.js';

export const AUTH_PROVIDERS = ['google', 'apple'] as const;

/** Links a user to an external identity provider account. */
export const authIdentities = mysqlTable(
  'auth_identities',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: mysqlEnum('provider', AUTH_PROVIDERS).notNull(),
    providerUserId: varchar('provider_user_id', { length: 191 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_uq').on(t.provider, t.providerUserId),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

/** Opaque refresh tokens (stored hashed) with rotation and reuse detection. */
export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    familyId: id('family_id').notNull(),
    userAgent: varchar('user_agent', { length: 255 }),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.familyId),
  ],
);

export const OTP_PURPOSES = ['register', 'login', 'password_reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const otpCodes = mysqlTable(
  'otp_codes',
  {
    id: id('id').primaryKey(),
    email: varchar('email', { length: 191 }).notNull(),
    purpose: mysqlEnum('purpose', OTP_PURPOSES).notNull(),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    attempts: int('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('otp_codes_lookup_idx').on(t.email, t.purpose, t.createdAt)],
);

/**
 * Issued once a password-reset code has been verified; exchanged (once) for a
 * new password. Stored hashed, short-lived, single-use.
 */
export const passwordResetTokens = mysqlTable(
  'password_reset_tokens',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    usedAt: timestamp('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('password_reset_tokens_hash_uq').on(t.tokenHash),
    index('password_reset_tokens_user_idx').on(t.userId),
  ],
);
