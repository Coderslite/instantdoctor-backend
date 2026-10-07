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
import { createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';
import { familySubscriptions } from './payments.js';

export const PACKAGE_TYPES = ['basic', 'standard', 'special'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

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
    isPaid: boolean('is_paid').notNull().default(false),
    paidAt: timestamp('paid_at'),
    /** Unpaid bookings block the doctor's slot until this instant (extended on payment start). */
    holdExpiresAt: timestamp('hold_expires_at'),
    doctorEarning: money('doctor_earning'),

    /** Client `Idempotency-Key` that created this row; guarantees one booking per key. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),

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
    prescription: text('prescription').notNull(),
    seen: boolean('seen').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('prescriptions_appointment_idx').on(t.appointmentId, t.createdAt)],
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
