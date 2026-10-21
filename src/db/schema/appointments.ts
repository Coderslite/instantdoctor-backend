import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, exchangeRate, id, money, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';
import { familySubscriptions } from './payments.js';

export const PACKAGE_TYPES = ['basic', 'standard', 'special'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

/**
 * The benefits a patient buys with a consultation. Kept as JSON so new
 * display benefits can be introduced without a schema migration, while the
 * capability fields remain explicit enough for the API and clients to enforce.
 */
export type AppointmentPackageFeatures = {
  allowVideoCall: boolean;
  allowVoiceCall: boolean;
  allowChat: boolean;
  allowPrescription: boolean;
  allowFamilyCredit: boolean;
  followUpDays: number;
  /** Admin-authored, customer-facing inclusions (for example, "Care summary"). */
  included: string[];
};

/** Safe baseline used by imports and tests; commercial packages opt in to extras. */
export const DEFAULT_APPOINTMENT_PACKAGE_FEATURES: AppointmentPackageFeatures = {
  allowVideoCall: false,
  allowVoiceCall: false,
  allowChat: true,
  allowPrescription: true,
  allowFamilyCredit: false,
  followUpDays: 0,
  included: ['Secure chat', 'Prescription when clinically appropriate'],
};

/** Consultation packages. `amountUsd` is the base price before regional discount/FX. */
export const appointmentPackages = mysqlTable('appointment_packages', {
  id: id('id').primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  type: mysqlEnum('type', PACKAGE_TYPES).notNull(),
  amountUsd: money('amount_usd').notNull(),
  /** Legacy reference amount from Firestore `dollarAmount`; not used for charging. */
  listAmountUsd: money('list_amount_usd'),
  durationSeconds: int('duration_seconds').notNull(),
  description: text('description'),
  features: json('features').$type<AppointmentPackageFeatures>().notNull(),
  /** Controls sales ordering without relying on the legacy package type. */
  sortOrder: int('sort_order').notNull().default(0),
  isRecommended: boolean('is_recommended').notNull().default(false),
  badge: varchar('badge', { length: 64 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Legacy per-currency subscription packages (Firestore `AppointmentCharges/{currency}/packages`). */
export const appointmentChargePackages = mysqlTable(
  'appointment_charge_packages',
  {
    id: id('id').primaryKey(),
    currency: varchar('currency', { length: 3 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    amount: money('amount').notNull(),
    durationSeconds: int('duration_seconds').notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [index('appointment_charge_packages_currency_idx').on(t.currency)],
);

export const APPOINTMENT_STATUSES = ['pending', 'active', 'completed', 'cancelled', 'deleted'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointments = mysqlTable(
  'appointments',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    /** Null while the booking is an open request that any doctor may accept. */
    doctorId: id('doctor_id').references(() => users.id),
    complaint: text('complaint'),
    symptoms: json('symptoms').$type<string[]>().notNull(),
    status: mysqlEnum('status', APPOINTMENT_STATUSES).notNull().default('pending'),

    packageId: id('package_id').references(() => appointmentPackages.id, { onDelete: 'set null' }),
    /** Package name as booked; legacy rows carry free-text values like "Daily Subscription". */
    packageLabel: varchar('package_label', { length: 128 }).notNull(),
    packageType: mysqlEnum('package_type', PACKAGE_TYPES),
    /** Immutable copy of the selected package's benefits at booking time. */
    packageFeatures: json('package_features').$type<AppointmentPackageFeatures>(),

    startTime: timestamp('start_time').notNull(),
    endTime: timestamp('end_time').notNull(),
    timeZone: varchar('time_zone', { length: 64 }),

    price: money('price').notNull(),
    currency: varchar('currency', { length: 3 }),
    priceUsd: money('price_usd'),
    isTrial: boolean('is_trial').notNull().default(false),
    /** Covered by a Family Care monthly GP credit rather than a one-off payment. */
    isSubscriptionCredit: boolean('is_subscription_credit').notNull().default(false),
    subscriptionId: id('subscription_id').references(() => familySubscriptions.id, { onDelete: 'set null' }),
    /** Set when an HMO agreement priced this booking; the doctor earning was fixed at booking. */
    hmoClaimId: id('hmo_claim_id'),
    isPaid: boolean('is_paid').notNull().default(false),
    paidAt: timestamp('paid_at'),
    /** Unpaid bookings block the doctor's slot until this instant (extended on payment start). */
    holdExpiresAt: timestamp('hold_expires_at'),
    doctorEarning: money('doctor_earning'),
    doctorEarningConverted: money('doctor_earning_converted'),
    doctorEarningCurrency: varchar('doctor_earning_currency', { length: 3 }),
    doctorEarningExchangeRate: exchangeRate('doctor_earning_exchange_rate'),
    doctorEarningConvertedAt: timestamp('doctor_earning_converted_at'),

    /** Client `Idempotency-Key` that created this row; guarantees one booking per key. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),

    /** When the consultation was completed, and by whom: doctor | auto | admin. */
    completedAt: timestamp('completed_at'),
    completedBy: varchar('completed_by', { length: 16 }),
    /** First time each side joined the call: evidence the consultation happened. */
    doctorJoinedAt: timestamp('doctor_joined_at'),
    patientJoinedAt: timestamp('patient_joined_at'),
    /** The doctor was reminded to complete it after its end time. */
    completionRemindedAt: timestamp('completion_reminded_at'),
    /** Set when it can't be closed automatically; an admin decides. Reason: no_activity | not_accepted | paid_after_cancel. */
    needsReviewAt: timestamp('needs_review_at'),
    reviewReason: varchar('review_reason', { length: 32 }),
    refundedAt: timestamp('refunded_at'),
    refundedAmount: money('refunded_amount'),

    reminderCount: int('reminder_count').notNull().default(0),
    reminderCountToday: int('reminder_count_today').notNull().default(0),
    lastReminderSentAt: timestamp('last_reminder_sent_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('appointments_idempotency_uq').on(t.userId, t.idempotencyKey),
    index('appointments_doctor_time_idx').on(t.doctorId, t.startTime, t.endTime),
    index('appointments_user_updated_idx').on(t.userId, t.updatedAt),
    index('appointments_user_paid_idx').on(t.userId, t.isPaid),
    index('appointments_open_idx').on(t.status, t.doctorId, t.startTime),
    index('appointments_lifecycle_idx').on(t.status, t.endTime),
    index('appointments_review_idx').on(t.needsReviewAt),
  ],
);

export const MESSAGE_TYPES = ['text', 'image', 'file', 'voice'] as const;
export const MESSAGE_STATUSES = ['pending', 'sent', 'delivered', 'read', 'deleted'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Consultation chat. `message`/`repliedText` hold whatever the client sends —
 * the mobile app currently encrypts them client-side, so they are stored opaque.
 */
export const appointmentMessages = mysqlTable(
  'appointment_messages',
  {
    id: id('id').primaryKey(),
    appointmentId: id('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    senderId: id('sender_id').notNull(),
    receiverId: id('receiver_id').notNull(),
    type: mysqlEnum('type', MESSAGE_TYPES).notNull().default('text'),
    status: mysqlEnum('status', MESSAGE_STATUSES).notNull().default('delivered'),
    message: text('message').notNull(),
    fileUrl: varchar('file_url', { length: 1024 }),
    repliedToId: id('replied_to_id'),
    repliedText: text('replied_text'),
    repliedSenderId: id('replied_sender_id'),
    isEdited: boolean('is_edited').notNull().default(false),
    editedAt: timestamp('edited_at'),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('appointment_messages_thread_idx').on(t.appointmentId, t.createdAt),
    index('appointment_messages_unread_idx').on(t.appointmentId, t.senderId, t.status),
  ],
);

export const prescriptions = mysqlTable(
  'prescriptions',
  {
    id: id('id').primaryKey(),
    appointmentId: id('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    userId: id('user_id').notNull(),
    doctorId: id('doctor_id').notNull(),
    /** Readable text of the whole prescription (items + notes); what older apps show. */
    prescription: text('prescription').notNull(),
    /** Doctor's free-text advice alongside the structured items. */
    notes: text('notes'),
    /** Short code a pharmacist uses to verify it, e.g. RX-7KQ2M9. Null on legacy text-only prescriptions. */
    code: varchar('code', { length: 16 }),
    /** Medicines can't be dispensed against it after this. */
    expiresAt: timestamp('expires_at'),
    seen: boolean('seen').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('prescriptions_appointment_idx').on(t.appointmentId, t.createdAt),
    index('prescriptions_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('prescriptions_code_uq').on(t.code),
  ],
);

/** One prescribed medicine. `quantity` is how many units (packs) may be dispensed in total. */
export const prescriptionItems = mysqlTable(
  'prescription_items',
  {
    id: id('id').primaryKey(),
    prescriptionId: id('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'cascade' }),
    /** Generic or brand name, e.g. Amoxicillin. */
    name: varchar('name', { length: 200 }).notNull(),
    /** e.g. 500mg. */
    strength: varchar('strength', { length: 60 }),
    /** e.g. capsule, syrup. */
    form: varchar('form', { length: 40 }),
    /** e.g. 1 capsule three times daily after meals. */
    directions: varchar('directions', { length: 500 }).notNull(),
    durationDays: int('duration_days'),
    quantity: int('quantity').notNull().default(1),
    sortOrder: int('sort_order').notNull().default(0),
  },
  (t) => [index('prescription_items_prescription_idx').on(t.prescriptionId, t.sortOrder)],
);

export const reviews = mysqlTable(
  'reviews',
  {
    id: id('id').primaryKey(),
    appointmentId: id('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    doctorId: id('doctor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: tinyint('rating').notNull(),
    review: text('review'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reviews_appointment_user_uq').on(t.appointmentId, t.userId),
    index('reviews_doctor_idx').on(t.doctorId),
  ],
);

export const REPORT_STATUSES = ['pending', 'in_progress', 'resolved', 'closed'] as const;

/** A patient's complaint about an appointment, handled by support (`admin`). */
export const reports = mysqlTable(
  'reports',
  {
    id: id('id').primaryKey(),
    appointmentId: id('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    doctorId: id('doctor_id'),
    subject: varchar('subject', { length: 255 }).notNull(),
    report: text('report').notNull(),
    status: mysqlEnum('status', REPORT_STATUSES).notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('reports_appointment_uq').on(t.appointmentId),
    index('reports_user_updated_idx').on(t.userId, t.updatedAt),
  ],
);

export const reportMessages = mysqlTable(
  'report_messages',
  {
    id: id('id').primaryKey(),
    reportId: id('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    /** A user id, or the literal "admin" for support replies. */
    senderId: id('sender_id').notNull(),
    receiverId: id('receiver_id').notNull(),
    type: mysqlEnum('type', MESSAGE_TYPES).notNull().default('text'),
    status: mysqlEnum('status', MESSAGE_STATUSES).notNull().default('delivered'),
    message: text('message').notNull(),
    fileUrl: varchar('file_url', { length: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [index('report_messages_thread_idx').on(t.reportId, t.createdAt)],
);
