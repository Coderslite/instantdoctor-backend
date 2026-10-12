import {
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { appointmentPackages } from './appointments.js';
import { admins, users } from './users.js';

/**
 * HMO partnerships. An HMO has plans; each plan is an agreement made of rules,
 * one per service, that decide what an enrollee pays, what the HMO is billed
 * and what the doctor earns. Enrollees are the HMO's members, linked to app
 * accounts. Every covered service produces a claim, grouped into invoices.
 * All agreement amounts are in NGN.
 */

export const HMO_STATUSES = ['active', 'paused', 'ended'] as const;
export type HmoStatus = (typeof HMO_STATUSES)[number];

export const hmos = mysqlTable(
  'hmos',
  {
    id: id('id').primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    /** Short code printed on claims and invoices, e.g. AVON. */
    code: varchar('code', { length: 20 }).notNull(),
    logo: varchar('logo', { length: 1024 }),
    contactName: varchar('contact_name', { length: 200 }),
    contactEmail: varchar('contact_email', { length: 191 }),
    contactPhone: varchar('contact_phone', { length: 32 }),
    address: varchar('address', { length: 500 }),
    status: mysqlEnum('status', HMO_STATUSES).notNull().default('active'),
    /** Days the HMO has to pay an invoice. */
    paymentTermsDays: int('payment_terms_days').notNull().default(30),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('hmos_code_uq').on(t.code)],
);

export const hmoPlans = mysqlTable(
  'hmo_plans',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Contract window; coverage only applies inside it. Null = open-ended. */
    validFrom: timestamp('valid_from'),
    validTo: timestamp('valid_to'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('hmo_plans_hmo_idx').on(t.hmoId)],
);

export const HMO_SERVICES = ['consultation', 'lab_interpretation', 'medicines'] as const;
export type HmoService = (typeof HMO_SERVICES)[number];

/**
 * - full: patient pays 0; HMO billed `hmoAmount` (or the standard price).
 * - copay_fixed: patient pays `patientAmount`; HMO billed the rest (or `hmoAmount`).
 * - copay_percent: patient pays `percent`% of the standard price; HMO billed the rest (or `hmoAmount`).
 * - discount_percent: patient pays the standard price minus `percent`%; nothing billed.
 * - fixed_price: patient pays `patientAmount`; nothing billed.
 * - not_covered: excludes a package from a broader rule; standard price.
 */
export const HMO_COVERAGE_TYPES = [
  'full',
  'copay_fixed',
  'copay_percent',
  'discount_percent',
  'fixed_price',
  'not_covered',
] as const;
export type HmoCoverageType = (typeof HMO_COVERAGE_TYPES)[number];

export const HMO_LIMIT_PERIODS = ['month', 'year', 'contract'] as const;
/** Past the usage limit: charge the normal price, or refuse to book under the plan. */
export const HMO_OVER_LIMIT = ['standard_price', 'block'] as const;

export const hmoPlanRules = mysqlTable(
  'hmo_plan_rules',
  {
    id: id('id').primaryKey(),
    planId: id('plan_id')
      .notNull()
      .references(() => hmoPlans.id, { onDelete: 'cascade' }),
    service: mysqlEnum('service', HMO_SERVICES).notNull(),
    /** Consultations only: a specific package, or null for every package. */
    packageId: id('package_id').references(() => appointmentPackages.id, { onDelete: 'cascade' }),
    coverage: mysqlEnum('coverage', HMO_COVERAGE_TYPES).notNull(),
    patientAmount: money('patient_amount'),
    percent: decimal('percent', { precision: 5, scale: 2, mode: 'number' }),
    /** Agreed tariff billed to the HMO per use; null = computed from the standard price. */
    hmoAmount: money('hmo_amount'),
    /** Consultations only: fixed doctor pay; null = the usual share of (patient + HMO) amount. */
    doctorEarning: money('doctor_earning'),
    limitCount: int('limit_count'),
    /** Medicines: most the HMO pays per period, in naira. */
    limitAmount: money('limit_amount'),
    limitPeriod: mysqlEnum('limit_period', HMO_LIMIT_PERIODS),
    overLimit: mysqlEnum('over_limit', HMO_OVER_LIMIT).notNull().default('standard_price'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('hmo_plan_rules_plan_idx').on(t.planId, t.service)],
);

export const HMO_ENROLLEE_STATUSES = ['active', 'suspended', 'ended'] as const;
export const HMO_LINK_METHODS = ['admin', 'match', 'self'] as const;

export const hmoEnrollees = mysqlTable(
  'hmo_enrollees',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    planId: id('plan_id')
      .notNull()
      .references(() => hmoPlans.id),
    /** The member number on the enrollee's HMO card. */
    enrolleeCode: varchar('enrollee_code', { length: 64 }).notNull(),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    /** E.164 where it could be normalised. */
    phone: varchar('phone', { length: 32 }),
    email: varchar('email', { length: 191 }),
    /** YYYY-MM-DD. */
    dateOfBirth: varchar('date_of_birth', { length: 10 }),
    status: mysqlEnum('status', HMO_ENROLLEE_STATUSES).notNull().default('active'),
    validFrom: timestamp('valid_from'),
    validTo: timestamp('valid_to'),
    userId: id('user_id').references(() => users.id, { onDelete: 'set null' }),
    linkedAt: timestamp('linked_at'),
    linkMethod: mysqlEnum('link_method', HMO_LINK_METHODS),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('hmo_enrollees_code_uq').on(t.hmoId, t.enrolleeCode),
    // One HMO membership per app account (NULLs don't collide in MySQL).
    uniqueIndex('hmo_enrollees_user_uq').on(t.userId),
    index('hmo_enrollees_phone_idx').on(t.phone),
    index('hmo_enrollees_email_idx').on(t.email),
  ],
);

export const HMO_LINK_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** "Link my HMO" attempts that couldn't be confirmed automatically, for an admin to review. */
export const hmoLinkRequests = mysqlTable(
  'hmo_link_requests',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    enrolleeCode: varchar('enrollee_code', { length: 64 }).notNull(),
    /** Why it needs review: no_match | already_linked. */
    reason: varchar('reason', { length: 32 }).notNull(),
    details: json('details').$type<Record<string, string>>(),
    status: mysqlEnum('status', HMO_LINK_REQUEST_STATUSES).notNull().default('pending'),
    reviewedBy: id('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [index('hmo_link_requests_status_idx').on(t.status, t.createdAt)],
);

export const HMO_CLAIM_STATUSES = ['unbilled', 'invoiced', 'paid', 'rejected', 'void'] as const;
export type HmoClaimStatus = (typeof HMO_CLAIM_STATUSES)[number];

export const hmoClaims = mysqlTable(
  'hmo_claims',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id),
    planId: id('plan_id').references(() => hmoPlans.id, { onDelete: 'set null' }),
    enrolleeId: id('enrollee_id').references(() => hmoEnrollees.id, { onDelete: 'set null' }),
    ruleId: id('rule_id').references(() => hmoPlanRules.id, { onDelete: 'set null' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    service: mysqlEnum('service', HMO_SERVICES).notNull(),
    appointmentId: id('appointment_id'),
    labResultId: id('lab_result_id'),
    orderId: id('order_id'),
    description: varchar('description', { length: 255 }).notNull(),
    /** Snapshot of the enrollee code at the time of service. */
    enrolleeCode: varchar('enrollee_code', { length: 64 }).notNull(),
    coverage: mysqlEnum('coverage', HMO_COVERAGE_TYPES).notNull(),
    standardAmount: money('standard_amount').notNull(),
    patientAmount: money('patient_amount').notNull(),
    hmoAmount: money('hmo_amount').notNull(),
    doctorEarning: money('doctor_earning'),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    status: mysqlEnum('status', HMO_CLAIM_STATUSES).notNull().default('unbilled'),
    invoiceId: id('invoice_id'),
    statusNote: varchar('status_note', { length: 500 }),
    serviceDate: timestamp('service_date').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('hmo_claims_hmo_status_idx').on(t.hmoId, t.status, t.serviceDate),
    index('hmo_claims_enrollee_idx').on(t.enrolleeId, t.ruleId, t.serviceDate),
    index('hmo_claims_appointment_idx').on(t.appointmentId),
    index('hmo_claims_order_idx').on(t.orderId),
    index('hmo_claims_invoice_idx').on(t.invoiceId),
  ],
);

export const HMO_INVOICE_STATUSES = ['issued', 'paid', 'cancelled'] as const;

export const hmoInvoices = mysqlTable(
  'hmo_invoices',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id),
    /** e.g. INV/AVON/2026/10/0001. */
    reference: varchar('reference', { length: 40 }).notNull(),
    periodStart: timestamp('period_start').notNull(),
    periodEnd: timestamp('period_end').notNull(),
    claimCount: int('claim_count').notNull(),
    totalAmount: money('total_amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    status: mysqlEnum('status', HMO_INVOICE_STATUSES).notNull().default('issued'),
    dueAt: timestamp('due_at').notNull(),
    paidAt: timestamp('paid_at'),
    paymentReference: varchar('payment_reference', { length: 120 }),
    notes: text('notes'),
    createdBy: id('created_by').references(() => admins.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('hmo_invoices_reference_uq').on(t.reference),
    index('hmo_invoices_hmo_idx').on(t.hmoId, t.createdAt),
  ],
);

// ── HMO portal ──────────────────────────────────────────────────────────────

/**
 * - admin: everything, including the team and the HMO's contact details.
 * - manager: also adds, updates and imports members.
 * - viewer: read-only (claims, invoices, members, benefits).
 */
export const HMO_USER_ROLES = ['admin', 'manager', 'viewer'] as const;
export type HmoUserRole = (typeof HMO_USER_ROLES)[number];

/** People at an HMO who sign in to the HMO portal. */
export const hmoUsers = mysqlTable(
  'hmo_users',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: mysqlEnum('role', HMO_USER_ROLES).notNull().default('viewer'),
    status: mysqlEnum('status', ['active', 'inactive']).notNull().default('active'),
    /** Set whenever someone else chooses the password; the portal is locked until it changes. */
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    /** Bumped on password change, reset or deactivation so outstanding access tokens stop working. */
    sessionVersion: int('session_version').notNull().default(0),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('hmo_users_email_uq').on(t.email),
    index('hmo_users_hmo_idx').on(t.hmoId, t.status),
  ],
);

export const HMO_ACTIVITY_ACTORS = ['hmo_user', 'admin', 'system'] as const;
export type HmoActivityActor = (typeof HMO_ACTIVITY_ACTORS)[number];

/**
 * Who changed what for an HMO — its own team or Instant Doctor staff — shown to
 * both sides. The actor's name is a snapshot so history survives account removal.
 */
export const hmoActivity = mysqlTable(
  'hmo_activity',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    actorType: mysqlEnum('actor_type', HMO_ACTIVITY_ACTORS).notNull(),
    actorId: id('actor_id'),
    actorName: varchar('actor_name', { length: 200 }).notNull(),
    /** e.g. member.updated, invoice.paid, team.created. */
    action: varchar('action', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 32 }),
    entityId: id('entity_id'),
    summary: varchar('summary', { length: 500 }).notNull(),
    details: json('details').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('hmo_activity_hmo_idx').on(t.hmoId, t.createdAt),
    index('hmo_activity_entity_idx').on(t.hmoId, t.entityType, t.entityId),
  ],
);
