import { Router } from 'express';
import multer from 'multer';
import { env } from '../../config/env.js';
import { storeFile } from '../../integrations/storage.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { authenticate } from '../../middleware/authenticate.js';
import { uploadQuery } from './uploads.schemas.js';

const ALLOWED = /^(image\/(png|jpe?g|gif|webp|heic)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|audio\/(mpeg|mp4|aac|m4a|x-m4a|wav|ogg|webm))$/;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});

/** Leading bytes for formats with reliable signatures; a mismatch means a mislabelled file. */
const SIGNATURES: Array<{ type: RegExp; matches: (b: Buffer) => boolean }> = [
  { type: /^image\/png$/, matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: /^image\/jpe?g$/, matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: /^image\/gif$/, matches: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { type: /^image\/webp$/, matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: /^application\/pdf$/, matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

export function contentMatchesType(buffer: Buffer, mimetype: string): boolean {
  const rule = SIGNATURES.find((s) => s.type.test(mimetype));
  return rule ? rule.matches(buffer) : true;
}

export const uploadsRouter = Router();
uploadsRouter.use(authenticate);

/** multipart/form-data with a single `file` field. Returns a URL to reference in other requests. */
uploadsRouter.post('/', upload.single('file'), async (req, res) => {
  const { folder } = parse(uploadQuery, req.query);
  if (!req.file) throw badRequest('A file of a supported type is required in the "file" field');
  if (!contentMatchesType(req.file.buffer, req.file.mimetype)) {
    throw badRequest(`File content does not match its declared type (${req.file.mimetype})`);
  }
  res.status(201).json(await storeFile(folder, req.file));
});
