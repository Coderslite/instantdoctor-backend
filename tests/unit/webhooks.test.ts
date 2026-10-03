import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { FlutterwaveProvider } from '../../src/integrations/payments/flutterwave.provider.js';
import { PaystackProvider } from '../../src/integrations/payments/paystack.provider.js';
import { StripeProvider } from '../../src/integrations/payments/stripe.provider.js';
import { AppError } from '../../src/lib/errors.js';

const body = (v: unknown) => Buffer.from(JSON.stringify(v));

describe('Paystack webhook signature', () => {
  const provider = new PaystackProvider('sk_test_secret', 'https://example.com');
  const payload = body({ event: 'charge.success', data: { id: 42, reference: 'IDP_REF' } });

  it('accepts a valid HMAC-SHA512 signature', () => {
    const sig = createHmac('sha512', 'sk_test_secret').update(payload).digest('hex');
    expect(provider.parseWebhook(payload, { 'x-paystack-signature': sig })).toMatchObject({
      eventId: 'charge.success:42',
      reference: 'IDP_REF',
    });
  });

  it('rejects a tampered body', () => {
    const sig = createHmac('sha512', 'sk_test_secret').update(payload).digest('hex');
    const tampered = body({ event: 'charge.success', data: { id: 42, reference: 'OTHER' } });
    expect(() => provider.parseWebhook(tampered, { 'x-paystack-signature': sig })).toThrow(AppError);
  });
});

describe('Flutterwave webhook signature', () => {
  const provider = new FlutterwaveProvider('FLWSECK_TEST', 'my-secret-hash', 'https://example.com');
  const payload = body({ event: 'charge.completed', data: { id: 7, tx_ref: 'IDP_REF', status: 'successful' } });

  it('accepts the configured verif-hash', () => {
    expect(provider.parseWebhook(payload, { 'verif-hash': 'my-secret-hash' })).toMatchObject({
      eventId: 'charge.completed:7',
      reference: 'IDP_REF',
    });
  });

  it('rejects a wrong hash', () => {
    expect(() => provider.parseWebhook(payload, { 'verif-hash': 'nope' })).toThrow(AppError);
  });
});

describe('Stripe webhook signature', () => {
  const secret = 'whsec_test_secret';
  const provider = new StripeProvider('sk_test_123', secret);
  const payload = JSON.stringify({
    id: 'evt_1',
    object: 'event',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_1', object: 'payment_intent', metadata: { reference: 'IDP_REF' } } },
  });

  it('accepts a correctly signed event', () => {
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(provider.parseWebhook(Buffer.from(payload), { 'stripe-signature': header })).toMatchObject({
      eventId: 'evt_1',
      eventType: 'payment_intent.succeeded',
      reference: 'IDP_REF',
    });
  });

  it('rejects an unsigned event', () => {
    expect(() => provider.parseWebhook(Buffer.from(payload), {})).toThrow(AppError);
  });
});
