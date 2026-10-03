import { z } from 'zod';
import { isoDateTime } from '../../lib/validation.js';
import { MESSAGE_TYPES } from '../../db/schema/index.js';

export const createAppointmentSchema = z
  .object({
    /** Omit to create an open request that any doctor can accept (ignored for trials). */
    doctorId: z.string().min(1).max(36).optional(),
    packageId: z.string().min(1).max(36).optional(),
    isTrial: z.boolean().default(false),
    startTime: isoDateTime(),
    complaint: z.string().trim().max(5000).default(''),
    symptoms: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  })
  .refine((v) => v.isTrial || v.packageId, { message: 'packageId is required', path: ['packageId'] });

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const listAppointmentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['pending', 'active', 'completed', 'cancelled']).optional(),
});

export const doctorStatusSchema = z.object({ status: z.enum(['completed', 'cancelled']) });

export const listMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Cursor: return messages created strictly before this instant. */
  before: isoDateTime().optional(),
});

export const sendMessageSchema = z
  .object({
    type: z.enum(MESSAGE_TYPES).default('text'),
    message: z.string().max(20_000).default(''),
    fileUrl: z.url().max(1024).optional(),
    repliedToId: z.string().max(36).optional(),
    repliedText: z.string().max(20_000).optional(),
    repliedSenderId: z.string().max(36).optional(),
  })
  .refine((v) => v.message.length > 0 || v.fileUrl, { message: 'message or fileUrl is required' })
  .refine((v) => v.type === 'text' || v.fileUrl, { message: 'fileUrl is required for attachments', path: ['fileUrl'] });

export const editMessageSchema = z.object({ message: z.string().min(1).max(20_000) });

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().trim().max(2000).default(''),
});
