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
import { admins, users } from './users.js';

export const pharmacies = mysqlTable(
  'pharmacies',
  {
    id: id('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 191 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }),
    /** Set for owners created from an application: they sign in with a temporary password and must replace it. */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
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
    /** Part of the goods an HMO pays for (prescribed medicines); the customer pays totalAmount − hmoAmount. */
    hmoAmount: money('hmo_amount').notNull().default(0),
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
    /** Billed to the customer's HMO, not paid by them. The pharmacy's earning is unaffected. */
    hmoAmount: money('hmo_amount').notNull().default(0),
    hmoClaimId: id('hmo_claim_id'),
    /** Set when the order dispenses an e-prescription. */
    prescriptionId: id('prescription_id'),
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
    /** The prescribed medicine this line dispenses; counts against its prescribed quantity. */
    prescriptionItemId: id('prescription_item_id'),
    name: varchar('name', { length: 255 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    discount: int('discount').notNull().default(0),
    quantity: int('quantity').notNull(),
    image: varchar('image', { length: 1024 }),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    index('order_items_prescription_item_idx').on(t.prescriptionItemId),
  ],
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

export const POS_PAYMENT_METHODS = ['cash', 'card', 'transfer', 'pos_terminal', 'other'] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];
export type PosPayment = { method: PosPaymentMethod; amount: number; reference?: string | null };
export type PosStockWarning = { productId: string; name: string; requested: number; available: number };

/**
 * A walk-in sale rung up at the pharmacy counter. The id is generated on the
 * till so a sale recorded offline syncs exactly once, however often it retries.
 */
export const posSales = mysqlTable(
  'pos_sales',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    receiptNumber: varchar('receipt_number', { length: 40 }).notNull(),
    deviceId: varchar('device_id', { length: 64 }),
    /** Null when the pharmacy owner account rang up the sale. */
    cashierStaffId: id('cashier_staff_id').references(() => pharmacyStaff.id, { onDelete: 'set null' }),
    cashierName: varchar('cashier_name', { length: 255 }).notNull(),
    customerName: varchar('customer_name', { length: 255 }),
    customerPhone: varchar('customer_phone', { length: 32 }),
    subtotal: money('subtotal').notNull(),
    discountTotal: money('discount_total').notNull().default(0),
    total: money('total').notNull(),
    payments: json('payments').$type<PosPayment[]>().notNull(),
    amountTendered: money('amount_tendered').notNull(),
    changeDue: money('change_due').notNull().default(0),
    status: mysqlEnum('status', ['completed', 'voided']).notNull().default('completed'),
    notes: varchar('notes', { length: 500 }),
    voidReason: varchar('void_reason', { length: 255 }),
    voidedByName: varchar('voided_by_name', { length: 255 }),
    voidedAt: timestamp('voided_at'),
    /** Stock that was short when an offline sale reached the server. */
    stockWarnings: json('stock_warnings').$type<PosStockWarning[]>(),
    /** When the till recorded the sale; created_at is when it reached the server. */
    soldAt: timestamp('sold_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pos_sales_receipt_uq').on(t.pharmacyId, t.receiptNumber),
    index('pos_sales_pharmacy_idx').on(t.pharmacyId, t.soldAt),
    index('pos_sales_cashier_idx').on(t.pharmacyId, t.cashierStaffId, t.soldAt),
  ],
);

/** Sale lines snapshot the product as it was rung up. */
export const posSaleItems = mysqlTable(
  'pos_sale_items',
  {
    id: id('id').primaryKey(),
    saleId: id('sale_id')
      .notNull()
      .references(() => posSales.id, { onDelete: 'cascade' }),
    productId: id('product_id').references(() => products.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    sku: varchar('sku', { length: 80 }),
    batchNumber: varchar('batch_number', { length: 100 }),
    unitPrice: money('unit_price').notNull(),
    /** Percentage off the unit price. */
    discount: int('discount').notNull().default(0),
    quantity: int('quantity').notNull(),
    lineTotal: money('line_total').notNull(),
    /** Purchase cost at the time of sale, for margin reports. */
    unitCost: money('unit_cost'),
  },
  (t) => [index('pos_sale_items_sale_idx').on(t.saleId)],
);

export const PHARMACY_LEDGER_TYPES = ['order_earning', 'order_reversal', 'payout', 'payout_reversal', 'adjustment'] as const;
export type PharmacyLedgerType = (typeof PHARMACY_LEDGER_TYPES)[number];

/**
 * Every naira the platform owes a pharmacy, and every naira paid out. The
 * pharmacy's balance is the sum of its entries; `available_at` holds new
 * earnings back for a short clearing period before they can be withdrawn.
 */
export const pharmacyLedger = mysqlTable(
  'pharmacy_ledger',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', PHARMACY_LEDGER_TYPES).notNull(),
    /** Signed: earnings and reversals of payouts are positive, payouts negative. */
    amount: money('amount').notNull(),
    balanceAfter: money('balance_after').notNull(),
    description: varchar('description', { length: 255 }).notNull(),
    orderId: id('order_id').references(() => orders.id, { onDelete: 'set null' }),
    payoutId: id('payout_id'),
    createdBy: varchar('created_by', { length: 255 }),
    availableAt: timestamp('available_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('pharmacy_ledger_pharmacy_idx').on(t.pharmacyId, t.createdAt),
    index('pharmacy_ledger_order_idx').on(t.orderId),
    index('pharmacy_ledger_payout_idx').on(t.payoutId),
  ],
);

/** Where a pharmacy's money goes: one verified Nigerian bank account. */
export const pharmacyBankAccounts = mysqlTable('pharmacy_bank_accounts', {
  pharmacyId: id('pharmacy_id')
    .primaryKey()
    .references(() => pharmacies.id, { onDelete: 'cascade' }),
  bankCode: varchar('bank_code', { length: 32 }).notNull(),
  bankName: varchar('bank_name', { length: 128 }).notNull(),
  accountNumber: varchar('account_number', { length: 20 }).notNull(),
  /** As the bank resolved it, not as typed. */
  accountName: varchar('account_name', { length: 255 }).notNull(),
  recipientCode: varchar('recipient_code', { length: 64 }).notNull(),
  updatedBy: varchar('updated_by', { length: 255 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const PAYOUT_STATUSES = ['pending_approval', 'processing', 'paid', 'failed', 'rejected', 'cancelled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const pharmacyPayouts = mysqlTable(
  'pharmacy_payouts',
  {
    id: id('id').primaryKey(),
    pharmacyId: id('pharmacy_id')
      .notNull()
      .references(() => pharmacies.id, { onDelete: 'cascade' }),
    /** Our transfer reference, also sent to Paystack. */
    reference: varchar('reference', { length: 50 }).notNull(),
    amount: money('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('NGN'),
    trigger: mysqlEnum('trigger', ['on_demand', 'scheduled']).notNull(),
    status: mysqlEnum('status', PAYOUT_STATUSES).notNull().default('pending_approval'),
    bankName: varchar('bank_name', { length: 128 }).notNull(),
    accountNumber: varchar('account_number', { length: 20 }).notNull(),
    accountName: varchar('account_name', { length: 255 }).notNull(),
    recipientCode: varchar('recipient_code', { length: 64 }).notNull(),
    requestedBy: varchar('requested_by', { length: 255 }).notNull(),
    approvedBy: varchar('approved_by', { length: 255 }),
    approvedAt: timestamp('approved_at'),
    transferCode: varchar('transfer_code', { length: 64 }),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    /** The last thing that went wrong, shown to admins (e.g. Paystack balance too low). */
    lastError: varchar('last_error', { length: 500 }),
    paidAt: timestamp('paid_at'),
    runId: id('run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pharmacy_payouts_reference_uq').on(t.reference),
    index('pharmacy_payouts_pharmacy_idx').on(t.pharmacyId, t.createdAt),
    index('pharmacy_payouts_status_idx').on(t.status, t.createdAt),
  ],
);

/** One row per weekly payout run, so a week is never paid twice. */
export const pharmacyPayoutRuns = mysqlTable(
  'pharmacy_payout_runs',
  {
    id: id('id').primaryKey(),
    runKey: varchar('run_key', { length: 64 }).notNull(),
    startedBy: varchar('started_by', { length: 255 }).notNull(),
    payoutCount: int('payout_count').notNull().default(0),
    totalAmount: money('total_amount').notNull().default(0),
    completedAt: timestamp('completed_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('pharmacy_payout_runs_key_uq').on(t.runKey)],
);

export const PHARMACY_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PharmacyApplicationStatus = (typeof PHARMACY_APPLICATION_STATUSES)[number];

/** "Partner with us" from the website: reviewed by an admin, who creates the pharmacy on approval. */
export const pharmacyApplications = mysqlTable(
  'pharmacy_applications',
  {
    id: id('id').primaryKey(),
    pharmacyName: varchar('pharmacy_name', { length: 255 }).notNull(),
    contactName: varchar('contact_name', { length: 200 }).notNull(),
    contactRole: varchar('contact_role', { length: 120 }),
    email: varchar('email', { length: 191 }).notNull(),
    phone: varchar('phone', { length: 32 }).notNull(),
    address: varchar('address', { length: 512 }).notNull(),
    city: varchar('city', { length: 120 }),
    state: varchar('state', { length: 120 }),
    /** PCN premises licence number, checked by the reviewer. */
    licenceNumber: varchar('licence_number', { length: 80 }),
    /** Rough band chosen on the form, e.g. "2 – 5". */
    branches: varchar('branches', { length: 40 }),
    /** Picked from the address search on the form (Photon / OpenStreetMap). */
    latitude: coordinate('latitude'),
    longitude: coordinate('longitude'),
    message: text('message'),
    status: mysqlEnum('status', PHARMACY_APPLICATION_STATUSES).notNull().default('pending'),
    reviewNote: text('review_note'),
    reviewedBy: id('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at'),
    /** The pharmacy created on approval. */
    pharmacyId: id('pharmacy_id').references(() => pharmacies.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('pharmacy_applications_status_idx').on(t.status, t.createdAt),
    index('pharmacy_applications_email_idx').on(t.email),
  ],
);
