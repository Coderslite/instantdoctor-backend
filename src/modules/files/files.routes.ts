import { Router, type Request } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { presignUploadSchema, uploadRequestSchema } from './files.schemas.js';
import {
  completeUpload,
  createUpload,
  getOwnFile,
  uploadFile,
  type Uploader,
} from './files.service.js';
import { singleFile } from './upload-middleware.js';

const userUploader = (req: Request): Uploader => {
  const { userId, role } = currentUser(req);
  return { kind: role === 'doctor' ? 'doctor' : 'patient', id: userId };
};

const purposeOf = (req: Request) =>
  parse(uploadRequestSchema, { ...req.query, ...req.body }).purpose;

export const uploadsRouter = Router();
uploadsRouter.use(authenticate);

uploadsRouter.post('/', singleFile, async (req, res) => {
  res.status(201).json(await uploadFile(userUploader(req), purposeOf(req), req.file!));
});
uploadsRouter.post('/presign', async (req, res) => {
  const { purpose, ...plan } = parse(presignUploadSchema, req.body);
  res.status(201).json(await createUpload(userUploader(req), purpose, plan));
});
uploadsRouter.post('/:id/complete', async (req, res) => {
  res.json(await completeUpload(userUploader(req), String(req.params.id)));
});

export const filesRouter = Router();
filesRouter.use(authenticate);

filesRouter.get('/:id', async (req, res) => {
  res.json(await getOwnFile(userUploader(req), String(req.params.id)));
});

export { purposeOf };
