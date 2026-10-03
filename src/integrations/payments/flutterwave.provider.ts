import { safeEqual } from '../../lib/crypto.js';
import { toMinorUnits } from '../../lib/money.js';
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

const BASE_URL = 'https://api.flutterwave.com/v3';

interface FlutterwaveResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
}

export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave' as const;

  constructor(
    private readonly secretKey: string,
    private readonly webhookHash: string | undefined,
    private readonly redirectUrl: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as FlutterwaveResponse<T> | null;
    if (!res.ok || body?.status !== 'success') {
      throw new ProviderError('flutterwave', body?.message ?? `HTTP ${res.status}`);
    }
    return body.data;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    const data = await this.request<{ link: string }>('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: input.reference,
        amount: input.amount,
        currency: input.currency,
        redirect_url: this.redirectUrl,
        customer: { email: input.customer.email, name: input.customer.name },
        customizations: { title: 'Instant Doctor', description: input.description },
        meta: input.metadata,
      }),
    });
    return { providerReference: null, clientAction: { type: 'redirect', authorizationUrl: data.link } };
  }

  async verify(payment: { reference: string }): Promise<VerifyResult> {
    let data: { id: number; status: string; amount: number; currency: string; tx_ref: string; processor_response?: string };
    try {
      data = await this.request(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(payment.reference)}`);
    } catch (err) {
      // No transaction yet for this reference: the customer has not paid.
      if (err instanceof ProviderError && /no transaction/i.test(err.message)) {
        return { outcome: 'pending', amountMinor: 0, currency: '', providerReference: null };
      }
      throw err;
    }
    if (data.tx_ref !== payment.reference) {
      throw new ProviderError('flutterwave', 'Reference mismatch on verification');
    }
    const outcome =
      data.status === 'successful' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    return {
      outcome,
      amountMinor: toMinorUnits(data.amount, data.currency),
      currency: data.currency.toUpperCase(),
      providerReference: String(data.id),
      failureReason: outcome === 'failed' ? data.processor_response : undefined,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const signature = header(headers, 'verif-hash');
    if (!this.webhookHash || !signature || !safeEqual(signature, this.webhookHash)) {
      throw unauthorized('Invalid Flutterwave signature');
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      'event.type'?: string;
      data?: { id?: number; tx_ref?: string; txRef?: string };
      id?: number;
      txRef?: string;
    };
    // Flutterwave sends both the v3 shape ({ event, data }) and a legacy flat shape.
    const eventType = event.event ?? event['event.type'] ?? 'unknown';
    const id = event.data?.id ?? event.id;
    const reference = event.data?.tx_ref ?? event.data?.txRef ?? event.txRef ?? null;
    return { eventId: `${eventType}:${id ?? reference ?? 'unknown'}`, eventType, reference, payload: event };
  }
}
