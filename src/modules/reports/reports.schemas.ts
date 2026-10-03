import { z } from 'zod';
import { MESSAGE_TYPES } from '../../db/schema/index.js';

export const createReportSchema = z.object({
  appointmentId: z.string().min(1).max(36),
  subject: z.string().trim().min(3).max(255),
  report: z.string().trim().min(3).max(5000),
});

export const listReportsQuery = z.object({ appointmentId: z.string().max(36).optional() });

export const reportMessageSchema = z
  .object({
    type: z.enum(MESSAGE_TYPES).default('text'),
    message: z.string().max(5000).default(''),
    fileUrl: z.url().optional(),
  })
  .refine((v) => v.message || v.fileUrl, 'message or fileUrl is required');
