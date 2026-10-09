import { z } from 'zod';
import { ORDER_STATUSES } from '../../db/schema/index.js';

export const loginSchema = z.object({ email: z.email(), password: z.string().min(8).max(128) });
export const staffRoleSchema = z.enum(['manager', 'pharmacist', 'inventory_officer', 'sales_assistant']);
export const staffSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.email(),
  password: z.string().min(8).max(128),
  phoneNumber: z.string().trim().max(32).nullable().optional(),
  role: staffRoleSchema,
});
export const updateStaffSchema = z.object({ role: staffRoleSchema.optional(), status: z.enum(['active', 'inactive']).optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const listSchema = z.object({ search: z.string().trim().max(100).optional(), status: z.string().trim().max(40).optional(), categoryId: z.string().min(1).optional(), stock: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
export const productSchema = z.object({ categoryId: z.string().min(1).nullable().optional(), name: z.string().trim().min(1).max(255), sku: z.string().trim().max(80).nullable().optional(), manufacturer: z.string().trim().max(255).nullable().optional(), batchNumber: z.string().trim().max(100).nullable().optional(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), description: z.string().trim().max(5000).nullable().optional(), amount: z.coerce.number().nonnegative(), purchasePrice: z.coerce.number().nonnegative().nullable().optional(), discount: z.coerce.number().int().min(0).max(100).default(0), stockRemaining: z.coerce.number().int().nonnegative().default(0), reorderLevel: z.coerce.number().int().nonnegative().default(5), images: z.array(z.url().max(1024)).max(12).default([]), status: z.enum(['active', 'inactive', 'deleted']).default('active') });
export const updateProductSchema = productSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const stockSchema = z.object({ quantity: z.coerce.number().int(), reason: z.string().trim().max(255).optional() });
export const supplierSchema = z.object({ name: z.string().trim().min(1).max(255), contactName: z.string().trim().max(255).nullable().optional(), phoneNumber: z.string().trim().max(32).nullable().optional(), email: z.email().nullable().optional(), address: z.string().trim().max(512).nullable().optional(), status: z.enum(['active', 'inactive']).default('active') });
const purchaseItemSchema = z.object({ productId: z.string().min(1), quantity: z.coerce.number().int().positive(), unitCost: z.coerce.number().nonnegative(), batchNumber: z.string().trim().max(100).nullable().optional(), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });
export const purchaseOrderSchema = z.object({ supplierId: z.string().min(1).nullable().optional(), expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), notes: z.string().trim().max(5000).nullable().optional(), items: z.array(purchaseItemSchema).min(1).max(100) });
export const purchaseOrderStatusSchema = z.object({ status: z.enum(['ordered', 'cancelled']) });
export const receivePurchaseOrderSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), quantity: z.coerce.number().int().positive() })).min(1).max(100) });
export const importSchema = z.object({ products: z.array(productSchema.extend({ id: z.string().optional() })).min(1).max(500) });
export const orderStatusSchema = z.object({ status: z.enum(ORDER_STATUSES).refine((value) => value !== 'awaiting_payment', 'Awaiting payment is controlled by payment processing') });
const dayHours = z.object({ open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).nullable().optional();
export const openingHoursSchema = z.object({ mon: dayHours, tue: dayHours, wed: dayHours, thu: dayHours, fri: dayHours, sat: dayHours, sun: dayHours });
export const profileSchema = z.object({ coverImage: z.url().max(1024).nullable().optional(), description: z.string().trim().max(1000).nullable().optional(), openingHours: openingHoursSchema.nullable().optional(), timeZone: z.string().trim().min(3).max(64).optional(), deliveryMinutes: z.coerce.number().int().min(10).max(600).optional(), name: z.string().trim().min(1).max(255).optional(), phoneNumber: z.string().trim().max(32).nullable().optional(), address: z.string().trim().max(512).nullable().optional(), latitude: z.coerce.number().min(-90).max(90).nullable().optional(), longitude: z.coerce.number().min(-180).max(180).nullable().optional(), deliveryFeePerKm: z.coerce.number().nonnegative().optional(), discount: z.coerce.number().int().min(0).max(100).optional(), image: z.url().max(1024).nullable().optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const passwordSchema = z.object({ currentPassword: z.string().min(8).max(128), newPassword: z.string().min(8).max(128) });

export const availabilitySchema = z.object({ acceptingOrders: z.boolean() });
export const orderActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), etaMinutes: z.coerce.number().int().min(5).max(600) }),
  z.object({ action: z.literal('dispatch'), riderName: z.string().trim().min(2).max(120), riderPhone: z.string().trim().max(32).nullable().optional() }),
  z.object({ action: z.literal('deliver') }),
  z.object({ action: z.literal('cancel'), reason: z.string().trim().min(3).max(255) }),
]);
export const reviewReplySchema = z.object({ reply: z.string().trim().min(2).max(1000) });
export const issueResponseSchema = z.object({ response: z.string().trim().min(2).max(2000), resolve: z.boolean().default(false) });
export const issueListSchema = z.object({ status: z.enum(['open', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
export const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
