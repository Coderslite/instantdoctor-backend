import { z } from 'zod';

export const createLabResultSchema = z.object({
  files: z
    .array(z.object({ fileUrl: z.url().max(1024), fileType: z.enum(['Image', 'File']) }))
    .min(1)
    .max(10),
});
