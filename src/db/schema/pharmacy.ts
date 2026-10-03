import {
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { coordinate, createdAt, id, money, updatedAt } from '../columns.js';
import { users } from './users.js';

export const pharmacies = mysqlTable(
  'pharmacies',
  {
    id: id('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }),
    phoneNumber: varchar('phone_number', { length: 32 }),
    address: varchar('address', { length: 512 }),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),
    /** Charged per started kilometre between pharmacy and delivery address. */
    deliveryFeePerKm: money('delivery_fee_per_km').notNull().default(0),
    discount: int('discount').notNull().default(0),
    image: varchar('image', { length: 1024 }),
    balance: money('balance').notNull().default(0),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('pharmacies_email_uq').on(t.email), index('pharmacies_status_idx').on(t.status)],
);

export const productCategories = mysqlTable('product_categories', {
  id: id('id').primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
});

export const products = mysqlTable(
  'products',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    categoryId: id('category_id').references(() => productCategories.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    amount: money('amount').notNull(),
    purchasePrice: money('purchase_price'),
    discount: int('discount').notNull().default(0),
    stockRemaining: int('stock_remaining').notNull().default(0),
    images: json('images').$type<string[]>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('products_pharmacy_idx').on(t.pharmacyId, t.status)],
);

export const ORDER_STATUSES = [
  'awaiting_payment',
  'pending',
  'processing',
  'delivering',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** A cart paid in one transaction; it fans out into one order per pharmacy. */
export const orderCheckouts = mysqlTable(
  'order_checkouts',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    subtotal: money('subtotal').notNull(),
    deliveryFee: money('delivery_fee').notNull(),
    totalAmount: money('total_amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: mysqlEnum('status', ['awaiting_payment', 'paid', 'cancelled'])
      .notNull()
      .default('awaiting_payment'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('order_checkouts_user_idx').on(t.userId),
    uniqueIndex('order_checkouts_idempotency_uq').on(t.userId, t.idempotencyKey),
  ],
);

export const orders = mysqlTable(
  'orders',
  {
    id: id('id').primaryKey(),
    checkoutId: id('checkout_id').references(() => orderCheckouts.id, { onDelete: 'set null' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id),
    trackingId: varchar('tracking_id', { length: 16 }).notNull(),
    status: mysqlEnum('status', ORDER_STATUSES).notNull().default('awaiting_payment'),
    subtotal: money('subtotal').notNull(),
    deliveryFee: money('delivery_fee').notNull(),
    totalAmount: money('total_amount').notNull(),
    pharmacyEarning: money('pharmacy_earning'),
    platformEarning: money('platform_earning'),
    address: varchar('address', { length: 512 }),
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_tracking_uq').on(t.trackingId),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_checkout_idx').on(t.checkoutId),
  ],
);

/** Line items snapshot name and price at purchase time. */
export const orderItems = mysqlTable(
  'order_items',
  {
    id: id('id').primaryKey(),
    orderId: id('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: id('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    discount: int('discount').notNull().default(0),
    quantity: int('quantity').notNull(),
    image: varchar('image', { length: 1024 }),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);
