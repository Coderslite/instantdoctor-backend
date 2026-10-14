import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser, requireRole } from '../../middleware/authenticate.js';
import * as schemas from './doctor-payouts.schemas.js';
import * as service from './doctor-payouts.service.js';

/** The signed-in doctor's earnings, bank account and payouts: /doctor-earnings. */
export const doctorEarningsRouter = Router();
doctorEarningsRouter.use(authenticate, requireRole('doctor'));

const me = (req: Parameters<typeof currentUser>[0]) => currentUser(req).userId;

doctorEarningsRouter.get('/', async (req, res) => res.json(await service.summary(me(req))));
doctorEarningsRouter.get('/ledger', async (req, res) =>
  res.json(await service.ledger(me(req), parse(schemas.pageSchema, req.query))),
);
doctorEarningsRouter.get('/payouts', async (req, res) =>
  res.json(await service.listPayouts(me(req), parse(schemas.payoutListSchema, req.query))),
);
doctorEarningsRouter.post('/payouts', async (req, res) => {
  const input = parse(schemas.payoutRequestSchema, req.body);
  res.status(201).json(await service.requestPayout(me(req), { ...input, requestedBy: 'Doctor' }));
});
doctorEarningsRouter.post('/payouts/:id/cancel', async (req, res) =>
  res.json(await service.cancelPayout(me(req), String(req.params.id), 'Doctor')),
);
doctorEarningsRouter.get('/banks', async (_req, res) => res.json({ items: await service.listBanks() }));
doctorEarningsRouter.get('/bank-account', async (req, res) =>
  res.json({ bankAccount: await service.bankAccount(me(req)) }),
);
doctorEarningsRouter.put('/bank-account', async (req, res) =>
  res.json({ bankAccount: await service.saveBankAccount(me(req), parse(schemas.bankAccountSchema, req.body)) }),
);
