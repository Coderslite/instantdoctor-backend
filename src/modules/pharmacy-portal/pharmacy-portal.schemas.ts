import { z } from 'zod';
import { ORDER_STATUSES } from '../../db/schema/index.js';

export const loginSchema = z.object({ email: z.email(), password: z.string().min(8).max(128) });
export const listSchema = z.object({ search: z.string().trim().max(100).optional(), status: z.string().trim().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });
export const productSchema = z.object({ categoryId: z.string().min(1).nullable().optional(), name: z.string().trim().min(1).max(255), description: z.string().trim().max(5000).nullable().optional(), amount: z.coerce.number().nonnegative(), purchasePrice: z.coerce.number().nonnegative().nullable().optional(), discount: z.coerce.number().int().min(0).max(100).default(0), stockRemaining: z.coerce.number().int().nonnegative().default(0), images: z.array(z.url().max(1024)).max(12).default([]), status: z.enum(['active', 'inactive', 'deleted']).default('active') });
export const updateProductSchema = productSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const stockSchema = z.object({ quantity: z.coerce.number().int(), reason: z.string().trim().max(255).optional() });
export const importSchema = z.object({ products: z.array(productSchema.extend({ id: z.string().optional() })).min(1).max(500) });
export const orderStatusSchema = z.object({ status: z.enum(ORDER_STATUSES).refine((value) => value !== 'awaiting_payment', 'Awaiting payment is controlled by payment processing') });
export const profileSchema = z.object({ name: z.string().trim().min(1).max(255).optional(), phoneNumber: z.string().trim().max(32).nullable().optional(), address: z.string().trim().max(512).nullable().optional(), latitude: z.coerce.number().min(-90).max(90).nullable().optional(), longitude: z.coerce.number().min(-180).max(180).nullable().optional(), deliveryFeePerKm: z.coerce.number().nonnegative().optional(), discount: z.coerce.number().int().min(0).max(100).optional(), image: z.url().max(1024).nullable().optional() }).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const passwordSchema = z.object({ currentPassword: z.string().min(8).max(128), newPassword: z.string().min(8).max(128) });
