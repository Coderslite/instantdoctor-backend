import {
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, timestamp, updatedAt } from '../columns.js';
import { admins } from './users.js';

export const ADMIN_EMAIL_STATUSES = ['sending', 'sent', 'partial', 'failed'] as const;
export type AdminEmailStatus = (typeof ADMIN_EMAIL_STATUSES)[number];

/** An official letter sent from the admin Mail centre, with its audience and delivery totals. */
export const adminEmails = mysqlTable(
  'admin_emails',
  {
    id: id('id').primaryKey(),
    /** Printed on the letter, e.g. ID/2026/10/0007. */
    reference: varchar('reference', { length: 32 }).notNull(),
    adminId: id('admin_id').references(() => admins.id, { onDelete: 'set null' }),
    subject: varchar('subject', { length: 200 }).notNull(),
    /** Sanitised HTML body as written, before personalisation. */
    body: longtext('body').notNull(),
    signatureName: varchar('signature_name', { length: 128 }).notNull(),
    signatureTitle: varchar('signature_title', { length: 128 }),
    /** How recipients were chosen, for the history view. */
    audience: json('audience')
      .$type<{ segment: string | null; emails: number; users: number }>()
      .notNull(),
    status: mysqlEnum('status', ADMIN_EMAIL_STATUSES).notNull().default('sending'),
    recipientCount: int('recipient_count').notNull().default(0),
    sentCount: int('sent_count').notNull().default(0),
    failedCount: int('failed_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('admin_emails_created_idx').on(t.createdAt)],
);

export const ADMIN_EMAIL_RECIPIENT_STATUSES = ['pending', 'sent', 'failed'] as const;

export const adminEmailRecipients = mysqlTable(
  'admin_email_recipients',
  {
    id: id('id').primaryKey(),
    emailId: id('email_id')
      .notNull()
      .references(() => adminEmails.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 191 }).notNull(),
    name: varchar('name', { length: 200 }),
    userId: id('user_id'),
    /** Business-letter details for external recipients (job title, organisation, postal address). */
    details: json('details').$type<{
      title?: string | null;
      organization?: string | null;
      address?: string | null;
    }>(),
    status: mysqlEnum('status', ADMIN_EMAIL_RECIPIENT_STATUSES).notNull().default('pending'),
    error: text('error'),
    sentAt: timestamp('sent_at'),
  },
  (t) => [index('admin_email_recipients_email_idx').on(t.emailId, t.status)],
);
