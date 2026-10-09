import { index, int, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, timestamp, updatedAt } from '../columns.js';
import { admins, users } from './users.js';

/** `pending` until an admin reviews it; approval creates the doctor's account. */
export const DOCTOR_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DoctorApplicationStatus = (typeof DOCTOR_APPLICATION_STATUSES)[number];

export const DOCTOR_DOCUMENT_TYPES = [
  'practising_licence',
  'registration_certificate',
  'medical_degree',
  'government_id',
  'headshot',
  'cv',
  'housemanship_certificate',
  'specialist_certificate',
  'other',
] as const;
export type DoctorDocumentType = (typeof DOCTOR_DOCUMENT_TYPES)[number];

/** Every application must include these before it can be submitted. */
export const REQUIRED_DOCTOR_DOCUMENTS: readonly DoctorDocumentType[] = [
  'practising_licence',
  'registration_certificate',
  'medical_degree',
  'government_id',
  'headshot',
  'cv',
];

export interface DoctorApplicationDocument {
  type: DoctorDocumentType;
  fileId: string;
  name: string | null;
}

/**
 * Applications to join as a provider, submitted from the website. The applicant
 * chooses their password here; approval copies it onto the new doctor account so
 * they sign in to the doctor app with the same credentials.
 */
export const doctorApplications = mysqlTable(
  'doctor_applications',
  {
    id: id('id').primaryKey(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    phoneNumber: varchar('phone_number', { length: 32 }).notNull(),
    gender: varchar('gender', { length: 32 }),
    dateOfBirth: timestamp('date_of_birth'),
    country: varchar('country', { length: 64 }).notNull(),
    state: varchar('state', { length: 64 }),
    address: varchar('address', { length: 512 }),

    specialization: varchar('specialization', { length: 128 }).notNull(),
    experienceYears: int('experience_years').notNull(),
    licenceNumber: varchar('licence_number', { length: 64 }).notNull(),
    licensingBody: varchar('licensing_body', { length: 128 }).notNull(),
    licenceExpiresAt: timestamp('licence_expires_at'),
    institution: varchar('institution', { length: 255 }).notNull(),
    graduationYear: varchar('graduation_year', { length: 8 }).notNull(),
    housemanship: varchar('housemanship', { length: 255 }),
    housemanshipYear: varchar('housemanship_year', { length: 8 }),
    workplace: varchar('workplace', { length: 255 }),
    languages: varchar('languages', { length: 255 }),
    bio: text('bio'),
    documents: json('documents').$type<DoctorApplicationDocument[]>().notNull(),

    status: mysqlEnum('status', DOCTOR_APPLICATION_STATUSES).notNull().default('pending'),
    reviewNote: text('review_note'),
    reviewedBy: id('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at'),
    /** The doctor account created on approval. */
    userId: id('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('doctor_applications_status_idx').on(t.status, t.createdAt),
    index('doctor_applications_email_idx').on(t.email),
  ],
);
