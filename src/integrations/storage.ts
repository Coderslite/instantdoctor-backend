import { createHash, createHmac } from 'node:crypto';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import type { FileVisibility } from '../db/schema/files.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export interface StoredObject {
  key: string;
  body: Buffer;
  contentType: string;
  visibility: FileVisibility;
}

/** An object the client will upload itself; size and type are signed into the URL. */
export interface PlannedObject {
  key: string;
  contentType: string;
  size: number;
  visibility: FileVisibility;
}

/** Where and how the client sends the bytes: `PUT url` with exactly these headers. */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

export interface StorageDriver {
  put(object: StoredObject): Promise<void>;
  publicUrl(key: string): string;
  signedUrl(
    key: string,
    options: { expiresInSeconds: number; downloadName?: string | null },
  ): Promise<string>;
  remove(key: string, visibility: FileVisibility): Promise<void>;
  /** A short-lived URL the client PUTs the file to directly, bypassing the API. */
  presignUpload(object: PlannedObject, expiresInSeconds: number): Promise<PresignedUpload>;
  /** Size and type of a stored object, or null when nothing was uploaded. */
  stat(
    key: string,
    visibility: FileVisibility,
  ): Promise<{ size: number; contentType: string | null } | null>;
  /** The first `bytes` of a stored object, to check its real format. */
  readStart(key: string, visibility: FileVisibility, bytes: number): Promise<Buffer>;
}

const contentDisposition = (name?: string | null) =>
  name ? `inline; filename="${name.replace(/[^\w.\- ]/g, '_').slice(0, 120)}"` : 'inline';

const localSigningKey = () =>
  createHash('sha256').update(`local-files:${env.JWT_ACCESS_SECRET}`).digest();

const localSignature = (key: string, expires: number) =>
  createHmac('sha256', localSigningKey()).update(`${key}:${expires}`).digest('base64url');

export function verifyLocalSignature(key: string, expires: number, signature: string): boolean {
  return (
    Number.isFinite(expires) &&
    expires * 1000 > Date.now() &&
    safeEqual(localSignature(key, expires), signature)
  );
}

/** Local stand-in for a presigned PUT: the signature covers the key, visibility, type, size and expiry. */
const localUploadSignature = (o: PlannedObject, expires: number) =>
  createHmac('sha256', localSigningKey())
    .update(`put:${o.visibility}:${o.key}:${o.contentType}:${o.size}:${expires}`)
    .digest('base64url');

export function verifyLocalUpload(o: PlannedObject, expires: number, signature: string): boolean {
  return (
    Number.isFinite(expires) &&
    expires * 1000 > Date.now() &&
    safeEqual(localUploadSignature(o, expires), signature)
  );
}

export const localPath = (visibility: FileVisibility, key: string) =>
  join(resolve(env.UPLOAD_DIR), visibility, key);

const localDriver: StorageDriver = {
  async put({ key, body, visibility }) {
    const path = localPath(visibility, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  },
  publicUrl: (key) => `${env.PUBLIC_BASE_URL}/files/public/${key}`,
  async signedUrl(key, { expiresInSeconds }) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return `${env.PUBLIC_BASE_URL}/files/private/${key}?expires=${expires}&signature=${localSignature(key, expires)}`;
  },
  async remove(key, visibility) {
    await rm(localPath(visibility, key), { force: true });
  },
  async presignUpload(object, expiresInSeconds) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const query = new URLSearchParams({
      visibility: object.visibility,
      type: object.contentType,
      size: String(object.size),
      expires: String(expires),
      signature: localUploadSignature(object, expires),
    });
    return {
      url: `${env.PUBLIC_BASE_URL}/files/upload/${object.key}?${query}`,
      headers: { 'Content-Type': object.contentType },
    };
  },
  async stat(key, visibility) {
    const info = await stat(localPath(visibility, key)).catch(() => null);
    return info?.isFile() ? { size: info.size, contentType: null } : null;
  },
  async readStart(key, visibility, bytes) {
    const handle = await open(localPath(visibility, key), 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

function r2Driver(): StorageDriver {
  const client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
    forcePathStyle: true,
    // Otherwise presigned PUTs carry a CRC32 of an empty body and R2 rejects the real upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const bucket = (visibility: FileVisibility) =>
    visibility === 'public' ? (env.R2_PUBLIC_BUCKET ?? env.R2_BUCKET)! : env.R2_PRIVATE_BUCKET!;
  const publicBase = env.R2_PUBLIC_URL!.replace(/\/+$/, '');

  return {
    async put({ key, body, contentType, visibility }) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket(visibility),
            Key: key,
            Body: body,
            ContentType: contentType,
            CacheControl:
              visibility === 'public'
                ? 'public, max-age=31536000, immutable'
                : 'private, max-age=3600',
          }),
        );
      } catch (err) {
        logger.error({ err, key, visibility }, 'R2 upload failed');
        throw new AppError(502, 'STORAGE_ERROR', 'Could not store the file. Please try again.');
      }
    },
    publicUrl: (key) => `${publicBase}/${key}`,
    signedUrl: (key, { expiresInSeconds, downloadName }) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket('private'),
          Key: key,
          ResponseContentDisposition: contentDisposition(downloadName),
        }),
        { expiresIn: expiresInSeconds },
      ),
    async remove(key, visibility) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket(visibility), Key: key }));
    },
    async presignUpload({ key, contentType, size, visibility }, expiresInSeconds) {
      // Signing content-type and content-length makes R2 refuse a different type or size.
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket(visibility),
          Key: key,
          ContentType: contentType,
          ContentLength: size,
        }),
        {
          expiresIn: expiresInSeconds,
          signableHeaders: new Set(['content-type', 'content-length']),
        },
      );
      return { url, headers: { 'Content-Type': contentType } };
    },
    async stat(key, visibility) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket(visibility), Key: key }),
        );
        return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
      } catch (err) {
        if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
        logger.error({ err, key, visibility }, 'R2 stat failed');
        throw new AppError(
          502,
          'STORAGE_ERROR',
          'Could not check the uploaded file. Please try again.',
        );
      }
    },
    async readStart(key, visibility, bytes) {
      const object = await client.send(
        new GetObjectCommand({
          Bucket: bucket(visibility),
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );
      return Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    },
  };
}

let driver: StorageDriver | undefined;

export const storage = (): StorageDriver =>
  (driver ??= env.STORAGE_DRIVER === 'r2' ? r2Driver() : localDriver);

export function setStorageDriver(next: StorageDriver | undefined) {
  driver = next;
}
