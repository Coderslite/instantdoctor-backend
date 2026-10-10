import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config/env.js';
import { parse } from '../../lib/validation.js';
import {
  authenticateAdmin,
  currentAdmin,
  requireAdminRole,
} from '../../middleware/authenticate-admin.js';
import * as schemas from './mail-center.schemas.js';
import * as service from './mail-center.service.js';

/** Official letters from the admin, sent as contact@ on the Instant Doctor letterhead. Mounted at /admin/mail. */
export const mailCenterRouter = Router();
mailCenterRouter.use(authenticateAdmin);
const canSend = requireAdminRole('admin', 'marketer');
// Guards against a double-clicked or scripted send mailing everyone repeatedly.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
});

mailCenterRouter.post('/preview', async (req, res) =>
  res.json(service.preview(parse(schemas.previewSchema, req.body))),
);
mailCenterRouter.get('/audience', async (req, res) =>
  res.json(await service.audienceSize(parse(schemas.audienceQuery, req.query).segment)),
);
mailCenterRouter.post('/test', canSend, async (req, res) =>
  res.json(await service.sendTest(currentAdmin(req).adminId, parse(schemas.testSchema, req.body))),
);
mailCenterRouter.post('/', canSend, sendLimiter, async (req, res) =>
  res
    .status(202)
    .json(await service.send(currentAdmin(req).adminId, parse(schemas.sendSchema, req.body))),
);
mailCenterRouter.get('/', async (req, res) =>
  res.json(await service.history(parse(schemas.historyQuery, req.query))),
);
mailCenterRouter.get('/:id', async (req, res) =>
  res.json(await service.getEmail(String(req.params.id))),
);
