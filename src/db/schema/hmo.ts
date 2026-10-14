import {
  boolean,
  char,
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

export const HMO_PAYMENT_MODELS = ['fee_for_service', 'capitation'] as const;
export type HmoPaymentModel = (typeof HMO_PAYMENT_MODELS)[number];
/** How a covered use is paid for: billed per use, or already paid by the monthly capitation. */
export const HMO_BILLING = ['per_use', 'capitation'] as const;
export type HmoBilling = (typeof HMO_BILLING)[number];

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
    /**
     * fee_for_service: the HMO pays per covered use (claims).
     * capitation: the HMO also pays `capitationRate` per enrollee per month, and
     * rules billed by capitation cost it nothing per use.
     */
    paymentModel: mysqlEnum('payment_model', HMO_PAYMENT_MODELS).notNull().default('fee_for_service'),
    /** Naira per enrollee per month (capitation plans). */
    capitationRate: money('capitation_rate'),
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
    /**
     * Pre-authorisation: when the HMO's share of a use is above this (naira),
     * the HMO must approve it first. 0 = always; null = never.
     */
    authorizationAbove: money('authorization_above'),
    /** capitation: uses cost the HMO nothing (covered by the monthly payment); capitation plans only. */
    billing: mysqlEnum('billing', HMO_BILLING).notNull().default('per_use'),
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
    /** When the member last stopped being active; capitation counts who was active on the 1st. */
    deactivatedAt: timestamp('deactivated_at'),
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
    /** The HMO's pre-authorisation (PA) code, when the use needed approval. */
    authorizationCode: varchar('authorization_code', { length: 40 }),
    /** capitation: an encounter (₦0 to the HMO) recorded for utilisation; it still goes on the invoice. */
    billing: mysqlEnum('billing', HMO_BILLING).notNull().default('per_use'),
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
    /** Capitation billed on this invoice; included in totalAmount. */
    capitationAmount: money('capitation_amount').notNull().default(0),
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

export const HMO_AUTHORIZATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'used'] as const;
export type HmoAuthorizationStatus = (typeof HMO_AUTHORIZATION_STATUSES)[number];

/**
 * A pre-authorisation request: the member asks the HMO to approve a use whose
 * cost is above the agreement's threshold. Approval issues a PA code that the
 * next matching use consumes; if that use is cancelled the approval frees up.
 */
export const hmoAuthorizations = mysqlTable(
  'hmo_authorizations',
  {
    id: id('id').primaryKey(),
    hmoId: id('hmo_id')
      .notNull()
      .references(() => hmos.id, { onDelete: 'cascade' }),
    planId: id('plan_id'),
    ruleId: id('rule_id'),
    enrolleeId: id('enrollee_id')
      .notNull()
      .references(() => hmoEnrollees.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    service: mysqlEnum('service', HMO_SERVICES).notNull(),
    /** Consultations: the package asked for; null = any package. */
    packageId: id('package_id'),
    description: varchar('description', { length: 255 }).notNull(),
    patientNote: varchar('patient_note', { length: 1000 }),
    /** Normal price of what was asked for. */
    standardAmount: money('standard_amount').notNull(),
    /** What the HMO would pay (its share). */
    requestedAmount: money('requested_amount').notNull(),
    /** Most the approval covers; defaults to the requested amount. */
    approvedAmount: money('approved_amount'),
    status: mysqlEnum('status', HMO_AUTHORIZATION_STATUSES).notNull().default('pending'),
    /** PA code issued on approval, e.g. PA-AVON-7KQ2M9. */
    code: varchar('code', { length: 40 }),
    /** The HMO's own reference from its system, if it gave one. */
    hmoReference: varchar('hmo_reference', { length: 80 }),
    decisionNote: varchar('decision_note', { length: 500 }),
    decidedBy: varchar('decided_by', { length: 200 }),
    decidedAt: timestamp('decided_at'),
    /** An approval must be used before this. */
    expiresAt: timestamp('expires_at'),
    /** The claim that used the approval. */
    claimId: id('claim_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('hmo_authorizations_code_uq').on(t.code),
    index('hmo_authorizations_hmo_idx').on(t.hmoId, t.status, t.createdAt),
    index('hmo_authorizations_enrollee_idx').on(t.enrolleeId, t.service, t.status),
  ],
);

/**
 * One capitation charge: a capitation plan's members on the 1st of a month ×
 * its rate. Unique per plan and month so a month is never billed twice;
 * cancelling the invoice deletes its lines so the month can be billed again.
 */
export const hmoCapitationLines = mysqlTable(
  'hmo_capitation_lines',
  {
    id: id('id').primaryKey(),
    invoiceId: id('invoice_id')
      .notNull()
      .references(() => hmoInvoices.id, { onDelete: 'cascade' }),
    hmoId: id('hmo_id').notNull(),
    planId: id('plan_id')
      .notNull()
      .references(() => hmoPlans.id, { onDelete: 'cascade' }),
    /** YYYY-MM (Lagos). */
    month: char('month', { length: 7 }).notNull(),
    members: int('members').notNull(),
    rate: money('rate').notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('hmo_capitation_lines_plan_month_uq').on(t.planId, t.month),
    index('hmo_capitation_lines_invoice_idx').on(t.invoiceId),
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

// ── Partnership applications ────────────────────────────────────────────────

export const HMO_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type HmoApplicationStatus = (typeof HMO_APPLICATION_STATUSES)[number];

/**
 * "Apply to partner" submissions from the website. Approving one creates the
 * HMO and its first portal admin, whose sign-in details are emailed to them.
 */
export const hmoApplications = mysqlTable(
  'hmo_applications',
  {
    id: id('id').primaryKey(),
    organisation: varchar('organisation', { length: 200 }).notNull(),
    contactName: varchar('contact_name', { length: 200 }).notNull(),
    contactRole: varchar('contact_role', { length: 120 }),
    email: varchar('email', { length: 191 }).notNull(),
    phone: varchar('phone', { length: 32 }),
    /** Rough size band chosen on the form, e.g. "1,000 – 10,000". */
    enrollees: varchar('enrollees', { length: 40 }),
    services: json('services').$type<string[]>().notNull(),
    message: text('message'),
    status: mysqlEnum('status', HMO_APPLICATION_STATUSES).notNull().default('pending'),
    reviewNote: text('review_note'),
    reviewedBy: id('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at'),
    /** The HMO created on approval. */
    hmoId: id('hmo_id').references(() => hmos.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('hmo_applications_status_idx').on(t.status, t.createdAt),
    index('hmo_applications_email_idx').on(t.email),
  ],
);
