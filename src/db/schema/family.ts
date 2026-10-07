import { boolean, date, index, int, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';

export const FAMILY_RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'grandparent', 'other'] as const;
export type FamilyRelationship = (typeof FAMILY_RELATIONSHIPS)[number];

export const SEXES = ['male', 'female'] as const;

/**
 * A person whose care the account owner manages (a child, parent, spouse…).
 * Care plans and medications with a `profile_id` belong to that person; rows
 * without one belong to the account owner ("Me").
 */
export const familyProfiles = mysqlTable(
  'family_profiles',
  {
    id: id('id').primaryKey(),
    ownerUserId: id('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    relationship: mysqlEnum('relationship', FAMILY_RELATIONSHIPS).notNull(),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    sex: mysqlEnum('sex', SEXES),
    bloodGroup: varchar('blood_group', { length: 8 }),
    genotype: varchar('genotype', { length: 8 }),
    allergies: text('allergies'),
    conditions: text('conditions'),
    /** Whether the caregiver's device schedules reminders for this person. */
    caregiverReminders: boolean('caregiver_reminders').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('family_profiles_owner_idx').on(t.ownerUserId)],
);

/**
 * Consent-based, read-only links to a care summary. Only a SHA-256 hash of
 * the token is stored; links expire and can be revoked by the owner.
 */
export const careSummaryShares = mysqlTable(
  'care_summary_shares',
  {
    id: id('id').primaryKey(),
    ownerUserId: id('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: id('profile_id').references(() => familyProfiles.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    viewCount: int('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('care_summary_shares_token_uq').on(t.tokenHash),
    index('care_summary_shares_owner_idx').on(t.ownerUserId, t.createdAt),
  ],
);
