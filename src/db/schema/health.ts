import {
  boolean,
  date,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  time,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';

export const LAB_RESULT_STATUSES = ['awaiting_payment', 'pending', 'completed'] as const;
export type LabResultStatus = (typeof LAB_RESULT_STATUSES)[number];

export const labResults = mysqlTable(
  'lab_results',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', LAB_RESULT_STATUSES).notNull().default('awaiting_payment'),
    /** Price quoted at submission; null for legacy records. */
    price: money('price'),
    currency: varchar('currency', { length: 3 }),
    resultUrl: varchar('result_url', { length: 1024 }),
    testName: varchar('test_name', { length: 255 }),
    laboratoryName: varchar('laboratory_name', { length: 255 }),
    referenceNumber: varchar('reference_number', { length: 128 }),
    sampleCollectedAt: timestamp('sample_collected_at'),
    resultDate: timestamp('result_date'),
    interpretation: text('interpretation'),
    adminResponse: text('admin_response'),
    reviewedAt: timestamp('reviewed_at'),
    opened: boolean('opened').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('lab_results_user_idx').on(t.userId, t.createdAt)],
);

export const labResultFiles = mysqlTable(
  'lab_result_files',
  {
    id: id('id').primaryKey(),
    labResultId: id('lab_result_id')
      .notNull()
      .references(() => labResults.id, { onDelete: 'cascade' }),
    fileUrl: varchar('file_url', { length: 1024 }).notNull(),
    fileType: varchar('file_type', { length: 32 }).notNull(),
  },
  (t) => [index('lab_result_files_result_idx').on(t.labResultId)],
);

/** Medication schedule. Dose times are local wall-clock times on the patient's device. */
export const medications = mysqlTable(
  'medications',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    prescription: text('prescription'),
    startTime: timestamp('start_time').notNull(),
    endTime: timestamp('end_time').notNull(),
    morningTime: time('morning_time'),
    middayTime: time('midday_time'),
    eveningTime: time('evening_time'),
    intervalHours: int('interval_hours').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('medications_user_idx').on(t.userId)],
);

export const DOSE_STATUSES = ['taken', 'missed'] as const;
export type DoseStatus = (typeof DOSE_STATUSES)[number];

/**
 * One row per scheduled dose that was marked taken/missed. Replaces the
 * Firestore `takenDates` / `missedDates` / `dailyTakenTimes` / `dailyMissedTimes`
 * fields, which are all derivable from this table.
 */
export const medicationDoses = mysqlTable(
  'medication_doses',
  {
    id: id('id').primaryKey(),
    medicationId: id('medication_id')
      .notNull()
      .references(() => medications.id, { onDelete: 'cascade' }),
    doseDate: date('dose_date', { mode: 'string' }).notNull(),
    /** Null only for legacy records that tracked the day but not the dose time. */
    doseTime: time('dose_time'),
    status: mysqlEnum('status', DOSE_STATUSES).notNull(),
    recordedAt: createdAt(),
  },
  (t) => [uniqueIndex('medication_doses_slot_uq').on(t.medicationId, t.doseDate, t.doseTime)],
);
