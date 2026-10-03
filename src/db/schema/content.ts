import {
  boolean,
  index,
  int,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { coordinate, createdAt, id, money, timestamp, updatedAt } from '../columns.js';
import { users } from './users.js';

export const healthTipCategories = mysqlTable('health_tip_categories', {
  id: id('id').primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  image: varchar('image', { length: 1024 }),
});

export const healthTips = mysqlTable(
  'health_tips',
  {
    id: id('id').primaryKey(),
    categoryId: id('category_id').references(() => healthTipCategories.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }),
    /** HTML body. */
    description: longtext('description').notNull(),
    image: varchar('image', { length: 1024 }),
    type: varchar('type', { length: 32 }).notNull().default('article'),
    views: int('views').notNull().default(0),
    isSent: boolean('is_sent').notNull().default(false),
    publishedAt: timestamp('published_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('health_tips_category_published_idx').on(t.categoryId, t.publishedAt),
    uniqueIndex('health_tips_slug_uq').on(t.slug),
  ],
);

export const healthTipViews = mysqlTable(
  'health_tip_views',
  {
    healthTipId: id('health_tip_id')
      .notNull()
      .references(() => healthTips.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.healthTipId, t.userId] })],
);

export const healthTipLikes = mysqlTable(
  'health_tip_likes',
  {
    healthTipId: id('health_tip_id')
      .notNull()
      .references(() => healthTips.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.healthTipId, t.userId] })],
);

export const anonymousQuestions = mysqlTable(
  'anonymous_questions',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer'),
    status: mysqlEnum('status', ['pending', 'completed']).notNull().default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('anonymous_questions_user_idx').on(t.userId, t.createdAt)],
);

export const NOTIFICATION_TYPES = [
  'chat',
  'transaction',
  'appointment',
  'medication',
  'call',
  'lab_result',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notifications = mysqlTable(
  'notifications',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', NOTIFICATION_TYPES).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    uniqueId: varchar('unique_id', { length: 128 }),
    status: mysqlEnum('status', ['delivered', 'read']).notNull().default('delivered'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.status, t.createdAt)],
);

export const referrals = mysqlTable(
  'referrals',
  {
    id: id('id').primaryKey(),
    /** The referred (new) user. A user can only be referred once. */
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Referrer's tag as entered at sign-up. */
    referrerTag: varchar('referrer_tag', { length: 64 }).notNull(),
    referrerId: id('referrer_id').references(() => users.id, { onDelete: 'set null' }),
    status: mysqlEnum('status', ['active', 'inactive']).notNull().default('active'),
    signupBonusPaid: boolean('signup_bonus_paid').notNull().default(false),
    totalCommissionEarned: money('total_commission_earned').notNull().default(0),
    lastCommissionAt: timestamp('last_commission_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('referrals_user_uq').on(t.userId),
    index('referrals_referrer_idx').on(t.referrerTag, t.createdAt),
  ],
);

export const waitlistEntries = mysqlTable(
  'waitlist_entries',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    address: varchar('address', { length: 512 }).notNull(),
    latitude: coordinate('latitude').notNull(),
    longitude: coordinate('longitude').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('waitlist_entries_user_idx').on(t.userId)],
);
