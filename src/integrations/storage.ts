import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

export type UploadFolder = 'chat' | 'reports' | 'lab-results' | 'avatars' | 'blog';

export interface StoredFile {
  url: string;
  key: string;
  size: number;
  contentType: string;
}

interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
}

/** Development: files on disk, served by the API at /files/*. */
const localDriver: StorageDriver = {
  async put(key, body) {
    const path = join(resolve(env.UPLOAD_DIR), key);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, body);
    return `${env.PUBLIC_BASE_URL}/files/${key}`;
  },
};

/**
 * Cloudflare R2 (S3-compatible). Objects are served from the bucket's public
 * URL (custom domain or r2.dev), so files load on any device and survive
 * redeploys. Keys are random UUIDs, so objects are immutable and cacheable.
 */
function r2Driver(): StorageDriver {
  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
    forcePathStyle: true,
  });
  const publicBase = env.R2_PUBLIC_URL!.replace(/\/+$/, '');
  return {
    async put(key, body, contentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: env.R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable',
          }),
        );
      } catch (err) {
        logger.error({ err, key }, 'R2 upload failed');
        throw new AppError(502, 'STORAGE_ERROR', 'Could not store the file. Please try again.');
      }
      return `${publicBase}/${key}`;
    },
  };
}

let driver: StorageDriver | undefined;
const getDriver = () => (driver ??= env.STORAGE_DRIVER === 'r2' ? r2Driver() : localDriver);

/** Test hook. */
export function setStorageDriver(next: StorageDriver | undefined) {
  driver = next;
}

export async function storeFile(
  folder: UploadFolder,
  file: { buffer: Buffer; originalname: string; mimetype: string },
): Promise<StoredFile> {
  const ext = extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const key = `${folder}/${newId()}${ext}`;
  const url = await getDriver().put(key, file.buffer, file.mimetype);
  return { key, url, size: file.buffer.length, contentType: file.mimetype };
}
