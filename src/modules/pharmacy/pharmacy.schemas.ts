import { z } from 'zod';

export const nearbyQuery = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(100).default(5),
});

const location = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });

export const cartSchema = z.object({
  items: z
    .array(z.object({ productId: z.string().min(1).max(36), quantity: z.number().int().min(1).max(100) }))
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, 'Duplicate products in cart'),
  location,
});

export const checkoutSchema = cartSchema.extend({ address: z.string().trim().min(3).max(512) });

export const listOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['awaiting_payment', 'pending', 'processing', 'delivering', 'completed', 'cancelled']).optional(),
});

export const reviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export const issueSchema = z.object({
  category: z.enum(['missing_item', 'wrong_item', 'damaged', 'late', 'not_delivered', 'quality', 'other']),
  message: z.string().trim().min(5).max(2000),
});

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
