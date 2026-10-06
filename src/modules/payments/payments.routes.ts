import express, { Router } from 'express';
import { PAYMENT_PROVIDERS, type PaymentProviderName } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as service from './payments.service.js';

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

/** Start a payment. Requires an `Idempotency-Key` header. */
paymentsRouter.post('/', idempotent('payments.initialize'), async (req, res) => {
  const input = parse(service.initializePaymentSchema, req.body);
  const result = await service.initializePayment(currentUser(req).userId, input, req.idempotencyKey);
  res.status(201).json(result);
});

paymentsRouter.get('/:reference', async (req, res) => {
  res.json(service.serializePayment(await service.getPayment(currentUser(req).userId, req.params.reference)));
});

paymentsRouter.post('/:reference/verify', async (req, res) => {
  res.json(await service.verifyPayment(currentUser(req).userId, req.params.reference));
});

/** Bank transfer: the customer says they've sent the money. */
paymentsRouter.post('/:reference/transfer-sent', async (req, res) => {
  res.json(await service.confirmTransferSent(currentUser(req).userId, req.params.reference));
});

/**
 * Provider webhooks. Mounted before the JSON body parser: signature checks
 * need the exact raw bytes.
 */
export const webhooksRouter = Router();
webhooksRouter.use(express.raw({ type: '*/*', limit: '1mb' }));

webhooksRouter.post('/:provider', async (req, res) => {
  const provider = req.params.provider as PaymentProviderName;
  if (!PAYMENT_PROVIDERS.includes(provider)) throw notFound('Webhook');
  const result = await service.handleWebhook(provider, Buffer.isBuffer(req.body) ? req.body : undefined, req.headers);
  res.json(result);
});
