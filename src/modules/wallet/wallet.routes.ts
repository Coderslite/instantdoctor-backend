import { Router } from 'express';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { listTransactionsQuery, transferSchema } from './wallet.schemas.js';
import * as service from './wallet.service.js';

export const walletRouter = Router();
walletRouter.use(authenticate);

walletRouter.get('/', async (req, res) => {
  res.json(await service.getWallet(currentUser(req).userId));
});

walletRouter.get('/transactions', async (req, res) => {
  const query = parse(listTransactionsQuery, req.query);
  res.json({ items: await service.listTransactions(currentUser(req).userId, query), ...query });
});

/** Send funds to another user. Requires an `Idempotency-Key` header. */
walletRouter.post('/transfers', idempotent('wallet.transfer'), async (req, res) => {
  const input = parse(transferSchema, req.body);
  res.status(201).json(await service.transfer(currentUser(req).userId, input, req.idempotencyKey));
});
