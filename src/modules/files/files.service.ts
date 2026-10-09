import { extname } from 'node:path';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { files, type FileOwnerType } from '../../db/schema/index.js';
import { storage } from '../../integrations/storage.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { newId } from '../../lib/ids.js';
import { FILE_POLICIES, type FilePurpose, type UploaderKind } from './file-policies.js';
import { contentMatchesType } from './file-signatures.js';

export interface Uploader {
  kind: UploaderKind;
  id: string;
}

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

type FileRow = typeof files.$inferSelect;

export const FILE_REF_PREFIX = 'file:';

const ownerType = (kind: UploaderKind): FileOwnerType =>
  kind === 'admin' || kind === 'pharmacy' || kind === 'applicant' ? kind : 'user';

/**
 * Owner id of an applicant's document until an application claims it. Claiming
 * sets the owner to the application, and approval hands it to the new doctor.
 */
export const UNCLAIMED_APPLICANT_FILE = 'unclaimed';

const isFileRef = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.startsWith(FILE_REF_PREFIX);

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
};

async function urlFor(row: FileRow) {
  if (row.visibility === 'public')
    return { url: storage().publicUrl(row.storageKey), urlExpiresAt: null };
  const url = await storage().signedUrl(row.storageKey, {
    expiresInSeconds: env.FILE_URL_TTL_SECONDS,
    downloadName: row.originalName,
  });
  return { url, urlExpiresAt: new Date(Date.now() + env.FILE_URL_TTL_SECONDS * 1000) };
}

export async function serializeFile(row: FileRow) {
  return {
    id: row.id,
    purpose: row.purpose,
    visibility: row.visibility,
    ...(await urlFor(row)),
    contentType: row.contentType,
    size: row.sizeBytes,
    name: row.originalName,
    createdAt: row.createdAt,
  };
}

export type FileView = Awaited<ReturnType<typeof serializeFile>>;

/** Checks a planned upload against its purpose's policy; returns the normalised content type. */
function checkPolicy(
  uploader: Uploader,
  purpose: FilePurpose,
  mimetype: string,
  size: number,
): string {
  const policy = FILE_POLICIES[purpose];
  if (!(policy.uploaders as readonly string[]).includes(uploader.kind)) {
    throw forbidden(`You can't upload files for "${purpose}"`);
  }
  const contentType = MIME_ALIASES[mimetype] ?? mimetype;
  if (!(policy.contentTypes as readonly string[]).includes(contentType)) {
    throw unprocessable(
      'UNSUPPORTED_FILE_TYPE',
      `${contentType} isn't allowed for ${policy.description.toLowerCase()}`,
      {
        allowed: policy.contentTypes,
      },
    );
  }
  if (size === 0) throw badRequest('The file is empty');
  if (size > policy.maxBytes) {
    throw unprocessable(
      'FILE_TOO_LARGE',
      `Files for ${purpose} must be ${Math.round(policy.maxBytes / 1024 / 1024)} MB or smaller`,
    );
  }
  return contentType;
}

function newFileRow(
  uploader: Uploader,
  purpose: FilePurpose,
  contentType: string,
  size: number,
  name: string,
): FileRow {
  const id = newId();
  const extension = extname(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '')
    .slice(0, 10);
  return {
    id,
    purpose,
    visibility: FILE_POLICIES[purpose].visibility,
    ownerType: ownerType(uploader.kind),
    ownerId: uploader.id,
    storageKey: `${purpose.replace(/_/g, '-')}/${id}${extension}`,
    contentType,
    sizeBytes: size,
    originalName: name.slice(0, 255) || null,
    status: 'ready',
    createdAt: new Date(),
    deletedAt: null,
  };
}

/** Multipart upload through the API (kept for local development and older clients). */
export async function uploadFile(
  uploader: Uploader,
  purpose: FilePurpose,
  file: IncomingFile,
): Promise<FileView> {
  const contentType = checkPolicy(uploader, purpose, file.mimetype, file.buffer.length);
  if (!contentMatchesType(file.buffer, contentType)) {
    throw badRequest(`File content does not match its declared type (${contentType})`);
  }
  const row = newFileRow(uploader, purpose, contentType, file.buffer.length, file.originalname);
  await storage().put({
    key: row.storageKey,
    body: file.buffer,
    contentType,
    visibility: row.visibility,
  });
  await db.insert(files).values(row);
  return serializeFile(row);
}

// ── Direct uploads ──────────────────────────────────────────────────────────
// 1. createUpload: policy is checked up front and a presigned PUT URL returned.
// 2. The client sends the bytes straight to storage.
// 3. completeUpload: the stored object is verified (size, type, magic bytes)
//    before the file can be attached anywhere.

export interface PlannedUpload {
  contentType: string;
  size: number;
  name?: string;
}

export async function createUpload(uploader: Uploader, purpose: FilePurpose, plan: PlannedUpload) {
  const contentType = checkPolicy(uploader, purpose, plan.contentType, plan.size);
  const row: FileRow = {
    ...newFileRow(uploader, purpose, contentType, plan.size, plan.name ?? ''),
    status: 'pending',
  };
  await db.insert(files).values(row);
  const upload = await storage().presignUpload(
    { key: row.storageKey, contentType, size: plan.size, visibility: row.visibility },
    env.UPLOAD_URL_TTL_SECONDS,
  );
  return {
    fileId: row.id,
    upload: {
      method: 'PUT' as const,
      ...upload,
      expiresAt: new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1000),
    },
  };
}

/** Bytes needed to recognise every format in file-signatures.ts. */
const SIGNATURE_BYTES = 16;

export async function completeUpload(uploader: Uploader, fileId: string): Promise<FileView> {
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.ownerType, ownerType(uploader.kind)),
        eq(files.ownerId, uploader.id),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Upload');
  if (row.status === 'ready') return serializeFile(row); // retried confirmation

  const stored = await storage().stat(row.storageKey, row.visibility);
  if (!stored)
    throw conflict(
      'UPLOAD_NOT_RECEIVED',
      'The file has not been uploaded yet. Upload it to the URL you were given, then try again.',
    );

  const reject = async (error: Error) => {
    await storage()
      .remove(row.storageKey, row.visibility)
      .catch((err: unknown) => logger.warn({ err, fileId }, 'Could not remove rejected upload'));
    await db.delete(files).where(eq(files.id, row.id));
    throw error;
  };
  const policy = FILE_POLICIES[row.purpose as FilePurpose];
  if (stored.size !== row.sizeBytes || stored.size > policy.maxBytes) {
    return reject(
      unprocessable(
        'UPLOAD_MISMATCH',
        'The uploaded file is not the size that was declared. Start the upload again.',
      ),
    );
  }
  if (stored.contentType && stored.contentType !== row.contentType) {
    return reject(
      unprocessable(
        'UPLOAD_MISMATCH',
        'The uploaded file is not the type that was declared. Start the upload again.',
      ),
    );
  }
  if (
    !contentMatchesType(
      await storage().readStart(row.storageKey, row.visibility, SIGNATURE_BYTES),
      row.contentType,
    )
  ) {
    return reject(badRequest(`File content does not match its declared type (${row.contentType})`));
  }

  await db.update(files).set({ status: 'ready' }).where(eq(files.id, row.id));
  return serializeFile({ ...row, status: 'ready' });
}

/** Deletes uploads that were started but never confirmed (and their objects, if any arrived). */
export async function purgeAbandonedUploads(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const stale = await db
    .select()
    .from(files)
    .where(
      and(eq(files.status, 'pending'), lt(files.createdAt, new Date(Date.now() - olderThanMs))),
    )
    .limit(500);
  for (const row of stale) {
    await storage()
      .remove(row.storageKey, row.visibility)
      .catch((err: unknown) =>
        logger.warn({ err, fileId: row.id }, 'Could not remove abandoned upload'),
      );
  }
  if (stale.length)
    await db.delete(files).where(
      inArray(
        files.id,
        stale.map((row) => row.id),
      ),
    );
  return stale.length;
}

/** Deletes applicant documents that no application claimed within a day (abandoned forms). */
export async function purgeUnclaimedApplicantFiles(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const stale = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.ownerType, 'applicant'),
        eq(files.ownerId, UNCLAIMED_APPLICANT_FILE),
        lt(files.createdAt, new Date(Date.now() - olderThanMs)),
      ),
    )
    .limit(500);
  for (const row of stale) {
    await storage()
      .remove(row.storageKey, row.visibility)
      .catch((err: unknown) =>
        logger.warn({ err, fileId: row.id }, 'Could not remove unclaimed applicant file'),
      );
  }
  if (stale.length)
    await db.delete(files).where(
      inArray(
        files.id,
        stale.map((row) => row.id),
      ),
    );
  return stale.length;
}

async function ownedFile(uploader: Uploader, fileId: string) {
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.ownerType, ownerType(uploader.kind)),
        eq(files.ownerId, uploader.id),
        eq(files.status, 'ready'),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound('File');
  return row;
}

export async function getOwnFile(uploader: Uploader, fileId: string): Promise<FileView> {
  return serializeFile(await ownedFile(uploader, fileId));
}

export async function attachFile(
  uploader: Uploader,
  fileId: string,
  purposes: readonly FilePurpose[],
): Promise<string> {
  const row = await ownedFile(uploader, fileId);
  if (!(purposes as readonly string[]).includes(row.purpose)) {
    throw unprocessable(
      'WRONG_FILE_PURPOSE',
      `This file was uploaded for "${row.purpose}" and can't be used here`,
      {
        expected: purposes,
      },
    );
  }
  return row.visibility === 'private'
    ? `${FILE_REF_PREFIX}${row.id}`
    : storage().publicUrl(row.storageKey);
}

export async function resolveFileUrls(
  values: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const ids = [...new Set(values.filter(isFileRef).map((v) => v.slice(FILE_REF_PREFIX.length)))];
  if (ids.length === 0) return resolved;
  const rows = await db.select().from(files).where(inArray(files.id, ids));
  await Promise.all(
    rows.map(async (row) => {
      if (!row.deletedAt && row.status === 'ready')
        resolved.set(`${FILE_REF_PREFIX}${row.id}`, (await urlFor(row)).url);
    }),
  );
  return resolved;
}

export async function resolveFileUrl(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (!isFileRef(value)) return value;
  return (await resolveFileUrls([value])).get(value) ?? null;
}

export async function withResolvedUrls<T, K extends keyof T>(
  items: T[],
  ...keys: K[]
): Promise<T[]> {
  const urls = await resolveFileUrls(
    items.flatMap((item) => keys.map((key) => item[key] as unknown as string | null)),
  );
  if (urls.size === 0) return items;
  return items.map((item) => {
    const copy = { ...item };
    for (const key of keys) {
      const value = item[key] as unknown as string | null;
      if (isFileRef(value)) (copy as Record<K, unknown>)[key] = urls.get(value) ?? null;
    }
    return copy;
  });
}
