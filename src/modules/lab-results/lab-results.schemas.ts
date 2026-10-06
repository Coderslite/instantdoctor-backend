import { z } from 'zod';

export const createLabResultSchema = z.object({
  files: z
    .array(
      z
        .object({
          fileId: z.string().min(1).max(36).optional(),
          fileUrl: z.url().max(1024).optional(),
          fileType: z.enum(['Image', 'File']),
        })
        .refine((f) => f.fileId || f.fileUrl, { message: 'fileId is required', path: ['fileId'] }),
    )
    .min(1)
    .max(10),
});
