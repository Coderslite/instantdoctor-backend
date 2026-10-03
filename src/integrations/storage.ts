import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';

export interface StoredFile {
  url: string;
  key: string;
  size: number;
  contentType: string;
}

/**
 * File storage. The local-disk driver serves files from `/files/*`; swap this
 * module for an S3/GCS implementation in production without touching callers.
 * Existing Firebase Storage URLs from the migration remain valid as-is.
 */
export async function storeFile(
  folder: 'chat' | 'reports' | 'lab-results' | 'avatars',
  file: { buffer: Buffer; originalname: string; mimetype: string },
): Promise<StoredFile> {
  const ext = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const key = `${folder}/${newId()}${ext}`;
  const dir = resolve(env.UPLOAD_DIR, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(resolve(env.UPLOAD_DIR), key), file.buffer);
  return {
    key,
    url: `${env.PUBLIC_BASE_URL}/files/${key}`,
    size: file.buffer.length,
    contentType: file.mimetype,
  };
}
