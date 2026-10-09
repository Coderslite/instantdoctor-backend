import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { coordinate, createdAt, id, money, timestamp, updatedAt } from '../columns.js';
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
    /** Square logo / profile image. */
    image: varchar('image', { length: 1024 }),
    /** Wide storefront photo shown on listing cards and the store page. */
    coverImage: varchar('cover_image', { length: 1024 }),
    /** Short "about the pharmacy" shown on the store page. */
    description: varchar('description', { length: 1000 }),
    /** Weekly hours, e.g. { mon: { open: '08:00', close: '20:00' }, sun: null }. Null = not set. */
    openingHours: json('opening_hours').$type<OpeningHours>(),
    /** IANA zone the opening hours are written in. */
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('Africa/Lagos'),
    /** The pharmacy's manual "accepting orders" switch, independent of hours. */
    acceptingOrders: boolean('accepting_orders').notNull().default(true),
    /** Typical minutes from accepting an order to delivering it. */
    deliveryMinutes: int('delivery_minutes').notNull().default(45),
    ratingTotal: int('rating_total').notNull().default(0),
    ratingCount: int('rating_count').notNull().default(0),
    balance: money('balance').notNull().default(0),
    /** onboarding → active (live) → suspended; or deleted. */
    status: varchar('status', { length: 32 }).notNull().default('onboarding'),
    liveAt: timestamp('live_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pharmacies_email_uq').on(t.email),
    index('pharmacies_status_idx').on(t.status),
  ],
);

export const pharmacyStaff = mysqlTable(
  'pharmacy_staff',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 191 }),
    passwordHash: varchar('password_hash', { length: 255 }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    sessionVersion: int('session_version').notNull().default(0),
    phoneNumber: varchar('phone_number', { length: 32 }),
    role: varchar('role', { length: 80 }).notNull(),
    status: mysqlEnum('status', ['active', 'inactive']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pharmacy_staff_email_uq').on(t.email),
    index('pharmacy_staff_pharmacy_idx').on(t.pharmacyId, t.status),
  ],
);

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** 24h "HH:mm" local times; null for a day the pharmacy is closed. */
export type OpeningHours = Partial<Record<Weekday, { open: string; close: string } | null>>;

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
    sku: varchar('sku', { length: 80 }),
    manufacturer: varchar('manufacturer', { length: 255 }),
    batchNumber: varchar('batch_number', { length: 100 }),
    expiryDate: varchar('expiry_date', { length: 10 }),
    description: text('description'),
    amount: money('amount').notNull(),
    purchasePrice: money('purchase_price'),
    discount: int('discount').notNull().default(0),
    stockRemaining: int('stock_remaining').notNull().default(0),
    reorderLevel: int('reorder_level').notNull().default(5),
    images: json('images').$type<string[]>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('products_pharmacy_idx').on(t.pharmacyId, t.status),
    index('products_expiry_idx').on(t.pharmacyId, t.expiryDate),
  ],
);

/** Auditable manual stock changes made from the pharmacy workspace. */
export const inventoryMovements = mysqlTable(
  'inventory_movements',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    productId: id('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: int('quantity').notNull(),
    reason: varchar('reason', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [index('inventory_movements_product_idx').on(t.productId, t.createdAt)],
);

/** Supplier directory and receiving documents are scoped to each pharmacy. */
export const suppliers = mysqlTable(
  'suppliers',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    contactName: varchar('contact_name', { length: 255 }),
    phoneNumber: varchar('phone_number', { length: 32 }),
    email: varchar('email', { length: 191 }),
    address: varchar('address', { length: 512 }),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('suppliers_pharmacy_idx').on(t.pharmacyId, t.status)],
);

export const purchaseOrders = mysqlTable(
  'purchase_orders',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    supplierId: id('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    reference: varchar('reference', { length: 32 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    expectedDate: varchar('expected_date', { length: 10 }),
    notes: text('notes'),
    totalCost: money('total_cost').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('purchase_orders_reference_uq').on(t.pharmacyId, t.reference),
    index('purchase_orders_pharmacy_idx').on(t.pharmacyId, t.status),
  ],
);

export const purchaseOrderItems = mysqlTable(
  'purchase_order_items',
  {
    id: id('id').primaryKey(),
    purchaseOrderId: id('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    productId: id('product_id').references(() => products.id, { onDelete: 'set null' }),
    productName: varchar('product_name', { length: 255 }).notNull(),
    quantity: int('quantity').notNull(),
    receivedQuantity: int('received_quantity').notNull().default(0),
    unitCost: money('unit_cost').notNull(),
    batchNumber: varchar('batch_number', { length: 100 }),
    expiryDate: varchar('expiry_date', { length: 10 }),
  },
  (t) => [index('purchase_order_items_order_idx').on(t.purchaseOrderId)],
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
    /** Minutes to delivery the pharmacy promised when accepting. */
    etaMinutes: int('eta_minutes'),
    /** The pharmacy's own rider, shared with the customer on dispatch. */
    riderName: varchar('rider_name', { length: 120 }),
    riderPhone: varchar('rider_phone', { length: 32 }),
    cancelReason: varchar('cancel_reason', { length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('orders_pharmacy_idx').on(t.pharmacyId, t.status, t.createdAt),
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

/** Every status change on an order, with who made it — the tracking timeline. */
export const orderEvents = mysqlTable(
  'order_events',
  {
    id: id('id').primaryKey(),
    orderId: id('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 32 }).notNull(),
    actor: varchar('actor', { length: 16 }).notNull(),
    note: varchar('note', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

/** One rating per delivered order; the pharmacy may reply once. */
export const pharmacyReviews = mysqlTable(
  'pharmacy_reviews',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    orderId: id('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    rating: int('rating').notNull(),
    comment: text('comment'),
    reply: text('reply'),
    repliedAt: timestamp('replied_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pharmacy_reviews_order_uq').on(t.orderId),
    index('pharmacy_reviews_pharmacy_idx').on(t.pharmacyId, t.createdAt),
  ],
);

export const ORDER_ISSUE_CATEGORIES = [
  'missing_item',
  'wrong_item',
  'damaged',
  'late',
  'not_delivered',
  'quality',
  'other',
] as const;

/** A problem a customer raised about an order, handled by the pharmacy. */
export const orderIssues = mysqlTable(
  'order_issues',
  {
    id: id('id').primaryKey(),
    orderId: id('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    category: mysqlEnum('category', ORDER_ISSUE_CATEGORIES).notNull(),
    message: text('message').notNull(),
    status: mysqlEnum('status', ['open', 'resolved']).notNull().default('open'),
    response: text('response'),
    respondedAt: timestamp('responded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('order_issues_pharmacy_idx').on(t.pharmacyId, t.status, t.createdAt),
    index('order_issues_order_idx').on(t.orderId),
  ],
);
