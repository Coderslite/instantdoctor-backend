import Stripe from 'stripe';
import { unauthorized } from '../../lib/errors.js';
import {
  header,
  ProviderError,
  type InitializeInput,
  type InitializeResult,
  type ParsedWebhook,
  type PaymentProvider,
  type VerifyResult,
} from './types.js';

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly client: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.client = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000 });
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    try {
      const intent = await this.client.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          description: input.description,
          receipt_email: input.customer.email || undefined,
          automatic_payment_methods: { enabled: true },
          metadata: { ...input.metadata, reference: input.reference },
        },
        // Stripe-side idempotency: retries never create a second PaymentIntent.
        { idempotencyKey: `pi-${input.reference}` },
      );
      if (!intent.client_secret) throw new Error('PaymentIntent has no client_secret');
      return {
        providerReference: intent.id,
        clientAction: {
          type: 'stripe_payment_sheet',
          clientSecret: intent.client_secret,
          paymentIntentId: intent.id,
        },
      };
    } catch (err) {
      throw new ProviderError('stripe', 'Failed to create PaymentIntent', err);
    }
  }

  async verify(payment: { reference: string; providerReference: string | null }): Promise<VerifyResult> {
    if (!payment.providerReference) {
      return { outcome: 'pending', amountMinor: 0, currency: '', providerReference: null };
    }
    const intent = await this.client.paymentIntents.retrieve(payment.providerReference);
    if (intent.metadata.reference !== payment.reference) {
      throw new ProviderError('stripe', 'PaymentIntent does not belong to this payment');
    }
    return {
      outcome:
        intent.status === 'succeeded' ? 'succeeded' : intent.status === 'canceled' ? 'failed' : 'pending',
      amountMinor: intent.amount_received,
      currency: intent.currency.toUpperCase(),
      providerReference: intent.id,
      failureReason: intent.last_payment_error?.message ?? intent.cancellation_reason ?? undefined,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const signature = header(headers, 'stripe-signature');
    if (!this.webhookSecret || !signature) throw unauthorized('Missing Stripe signature');
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    } catch {
      throw unauthorized('Invalid Stripe signature');
    }
    const object = event.data.object as { object?: string; metadata?: Record<string, string> };
    return {
      eventId: event.id,
      eventType: event.type,
      reference: object.object === 'payment_intent' ? (object.metadata?.reference ?? null) : null,
      payload: event,
    };
  }
}
