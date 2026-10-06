import { z } from 'zod';
import { FILE_PURPOSES, type FilePurpose } from './file-policies.js';

const LEGACY_FOLDERS: Record<string, FilePurpose> = {
  chat: 'chat_attachment',
  reports: 'report_attachment',
  'lab-results': 'lab_result',
  avatars: 'avatar',
};

export const uploadRequestSchema = z
  .object({
    purpose: z.enum(FILE_PURPOSES).optional(),
    folder: z.enum(Object.keys(LEGACY_FOLDERS) as [string, ...string[]]).optional(),
  })
  .transform((value, ctx) => {
    const purpose = value.purpose ?? (value.folder ? LEGACY_FOLDERS[value.folder] : undefined);
    if (!purpose) {
      ctx.addIssue({
        code: 'custom',
        path: ['purpose'],
        message: `purpose is required (one of ${FILE_PURPOSES.join(', ')})`,
      });
      return z.NEVER;
    }
    return { purpose };
  });

export const uploadDocSchema = z.object({
  purpose: z.enum(FILE_PURPOSES),
  file: z.string().meta({ format: 'binary' }),
});

/** Step 1 of a direct upload: what the client is about to send. */
export const presignUploadSchema = z.object({
  purpose: z.enum(FILE_PURPOSES),
  contentType: z.string().trim().toLowerCase().min(3).max(128).meta({ example: 'image/jpeg' }),
  size: z
    .number()
    .int()
    .positive()
    .meta({ description: 'Exact size in bytes; the storage URL only accepts this size.' }),
  name: z.string().trim().max(255).optional().meta({ example: 'lab-report.pdf' }),
});

export const fileIdSchema = z.object({ fileId: z.string().min(1).max(36) });
