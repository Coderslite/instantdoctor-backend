import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { badRequest, unprocessable } from '../../lib/errors.js';
import { MAX_UPLOAD_BYTES } from './file-policies.js';

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
}).single('file');

export function singleFile(req: Request, res: Response, next: NextFunction) {
  parser(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(
          unprocessable(
            'FILE_TOO_LARGE',
            `Files must be ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller`,
          ),
        );
      }
      return next(badRequest(`Upload rejected: ${err.message}`));
    }
    if (err) return next(err);
    if (!req.file)
      return next(badRequest('Send the file as multipart/form-data in a field named "file"'));
    next();
  });
}
