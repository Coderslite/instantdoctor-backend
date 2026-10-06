import { index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, timestamp } from '../columns.js';

export const FILE_VISIBILITIES = ['public', 'private'] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];

/** `pending` until a direct-to-storage upload is confirmed; only `ready` files can be attached. */
export const FILE_STATUSES = ['pending', 'ready'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const FILE_OWNER_TYPES = ['user', 'admin', 'pharmacy'] as const;
export type FileOwnerType = (typeof FILE_OWNER_TYPES)[number];

export const files = mysqlTable(
  'files',
  {
    id: id('id').primaryKey(),
    purpose: varchar('purpose', { length: 48 }).notNull(),
    visibility: mysqlEnum('visibility', FILE_VISIBILITIES).notNull(),
    ownerType: mysqlEnum('owner_type', FILE_OWNER_TYPES).notNull(),
    ownerId: id('owner_id').notNull(),
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    contentType: varchar('content_type', { length: 128 }).notNull(),
    sizeBytes: int('size_bytes').notNull(),
    originalName: varchar('original_name', { length: 255 }),
    status: mysqlEnum('status', FILE_STATUSES).notNull().default('ready'),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (t) => [
    uniqueIndex('files_storage_key_uq').on(t.storageKey),
    index('files_owner_idx').on(t.ownerType, t.ownerId, t.purpose),
    index('files_status_created_idx').on(t.status, t.createdAt),
  ],
);
