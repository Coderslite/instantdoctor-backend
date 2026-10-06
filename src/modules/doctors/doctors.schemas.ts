import { z } from 'zod';

export const listDoctorsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

export const certificateSchema = z.object({ fileId: z.string().min(1).max(36) });
