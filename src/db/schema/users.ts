import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { coordinate, createdAt, id, money, timestamp, updatedAt } from '../columns.js';

export const USER_ROLES = ['user', 'doctor'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** `pending_verification`: registered with email/password but the emailed code is not yet confirmed. */
export const REGISTRATION_STATUSES = ['pending_verification', 'active'] as const;

export const users = mysqlTable(
  'users',
  {
    id: id('id').primaryKey(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }),
    /**
     * Imported from Firebase Auth. Until the user's first successful login here,
     * a failed local password check falls back to Firebase (see auth.service).
     */
    legacyAuth: boolean('legacy_auth').notNull().default(false),
    role: mysqlEnum('role', USER_ROLES).notNull().default('user'),
    registrationStatus: mysqlEnum('registration_status', REGISTRATION_STATUSES).notNull().default('active'),

    firstName: varchar('first_name', { length: 100 }).notNull().default(''),
    lastName: varchar('last_name', { length: 100 }).notNull().default(''),
    phoneNumber: varchar('phone_number', { length: 32 }),
    photoUrl: varchar('photo_url', { length: 1024 }),
    gender: varchar('gender', { length: 32 }),
    dateOfBirth: timestamp('date_of_birth'),
    maritalStatus: varchar('marital_status', { length: 32 }),
    stateOfOrigin: varchar('state_of_origin', { length: 64 }),
    otherLanguage: varchar('other_language', { length: 255 }),

    country: varchar('country', { length: 64 }),
    currency: varchar('currency', { length: 3 }),
    earningCurrency: varchar('earning_currency', { length: 3 }).notNull().default('NGN'),
    platform: varchar('platform', { length: 16 }),
    address: varchar('address', { length: 512 }),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),

    tag: varchar('tag', { length: 64 }),
    presence: varchar('presence', { length: 16 }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at'),
    fcmToken: varchar('fcm_token', { length: 512 }),
    accountStatus: varchar('account_status', { length: 32 }),

    isTrialAvailable: boolean('is_trial_available').notNull().default(true),
    hasPaid: boolean('has_paid').notNull().default(false),
    walletBalance: money('wallet_balance').notNull().default(0),

    referralBalance: money('referral_balance').notNull().default(0),
    referralEnabled: boolean('referral_enabled').notNull().default(false),
    referralProgramApplied: boolean('referral_program_applied').notNull().default(false),
    referralProgramAppliedAt: timestamp('referral_program_applied_at'),

    /** Counters/timestamps owned by the engagement cron in the notification service. */
    reminderState: json('reminder_state').$type<Record<string, unknown>>(),

    emailVerifiedAt: timestamp('email_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    uniqueIndex('users_tag_uq').on(t.tag),
    index('users_role_presence_idx').on(t.role, t.lastSeenAt),
  ],
);

export const userMedicalProfiles = mysqlTable('user_medical_profiles', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  height: varchar('height', { length: 16 }),
  weight: varchar('weight', { length: 16 }),
  bloodGroup: varchar('blood_group', { length: 8 }),
  genotype: varchar('genotype', { length: 8 }),
  surgicalHistory: text('surgical_history'),
  updatedAt: updatedAt(),
});

export const doctorProfiles = mysqlTable(
  'doctor_profiles',
  {
    userId: id('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    specialization: varchar('specialization', { length: 128 }),
    experienceYears: int('experience_years'),
    bio: text('bio'),
    isAvailable: boolean('is_available').notNull().default(false),
    workingHours: json('working_hours').$type<unknown[]>(),
    certificateUrl: varchar('certificate_url', { length: 1024 }),
    institution: varchar('institution', { length: 255 }),
    graduationYear: varchar('graduation_year', { length: 8 }),
    housemanship: varchar('housemanship', { length: 255 }),
    housemanshipYear: varchar('housemanship_year', { length: 8 }),
    workAddress: varchar('work_address', { length: 512 }),
    homeAddress: varchar('home_address', { length: 512 }),
    registeredOn: varchar('registered_on', { length: 16 }),
    updatedAt: updatedAt(),
  },
  (t) => [index('doctor_profiles_available_idx').on(t.isAvailable)],
);

export const payoutAccounts = mysqlTable('payout_accounts', {
  userId: id('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  bankName: varchar('bank_name', { length: 128 }),
  bankCode: varchar('bank_code', { length: 32 }),
  accountNumber: varchar('account_number', { length: 32 }),
  accountName: varchar('account_name', { length: 255 }),
  recipientCode: varchar('recipient_code', { length: 64 }),
  updatedAt: updatedAt(),
});

export const savedLocations = mysqlTable(
  'saved_locations',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 128 }).notNull(),
    address: varchar('address', { length: 512 }).notNull(),
    latitude: coordinate('latitude').notNull(),
    longitude: coordinate('longitude').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('saved_locations_user_idx').on(t.userId)],
);

export const ADMIN_ROLES = ['admin', 'marketer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const admins = mysqlTable(
  'admins',
  {
    id: id('id').primaryKey(),
    name: varchar('name', { length: 128 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }),
    role: mysqlEnum('role', ADMIN_ROLES).notNull().default('admin'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('admins_email_uq').on(t.email)],
);
