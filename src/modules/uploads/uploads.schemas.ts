import { z } from 'zod';

export const UPLOAD_FOLDERS = ['chat', 'reports', 'lab-results', 'avatars'] as const;
export const uploadQuery = z.object({ folder: z.enum(UPLOAD_FOLDERS) });
