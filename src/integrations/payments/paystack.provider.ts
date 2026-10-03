import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';
import { unauthorized, unprocessable } from '../../lib/errors.js';
import {
  header,
  ProviderError,
  type InitializeInput,
  type InitializeResult,
  type ParsedWebhook,
  type PaymentProvider,
  type VerifyResult,
} from './types.js';

const BASE_URL = 'https://api.paystack.co';
const SUPPORTED_CURRENCIES = new Set(['NGN', 'GHS', 'ZAR', 'KES', 'USD', 'XOF', 'EGP']);

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;

  constructor(
    private readonly secretKey: string,
    private readonly callbackUrl: string,
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
    const body = (await res.json().catch(() => null)) as PaystackResponse<T> | null;
    if (!res.ok || !body?.status) {
      throw new ProviderError('paystack', body?.message ?? `HTTP ${res.status}`);
    }
    return body.data;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    if (!SUPPORTED_CURRENCIES.has(input.currency)) {
      throw unprocessable('CURRENCY_NOT_SUPPORTED', `Paystack does not support ${input.currency}`);
    }
    const data = await this.request<{ authorization_url: string; access_code: string; reference: string }>(
      '/transaction/initialize',
      {
        method: 'POST',
        body: JSON.stringify({
          email: input.customer.email,
          amount: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
          callback_url: this.callbackUrl,
          metadata: { ...input.metadata, description: input.description },
        }),
      },
    );
    return {
      providerReference: null,
      clientAction: {
        type: 'redirect',
        authorizationUrl: data.authorization_url,
        accessCode: data.access_code,
      },
    };
  }

  async verify(payment: { reference: string }): Promise<VerifyResult> {
    const data = await this.request<{
      id: number;
      status: string;
      amount: number;
      currency: string;
      reference: string;
      gateway_response?: string;
    }>(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
    if (data.reference !== payment.reference) {
      throw new ProviderError('paystack', 'Reference mismatch on verification');
    }
    const outcome =
      data.status === 'success'
        ? 'succeeded'
        : data.status === 'failed' || data.status === 'reversed'
          ? 'failed'
          : 'pending';
    return {
      outcome,
      amountMinor: data.amount,
      currency: data.currency.toUpperCase(),
      providerReference: String(data.id),
      failureReason: outcome === 'failed' ? data.gateway_response : undefined,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook {
    const signature = header(headers, 'x-paystack-signature');
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    if (!signature || !safeEqual(signature, expected)) throw unauthorized('Invalid Paystack signature');
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data?: { id?: number; reference?: string };
    };
    return {
      eventId: `${event.event}:${event.data?.id ?? event.data?.reference ?? 'unknown'}`,
      eventType: event.event,
      reference: event.data?.reference ?? null,
      payload: event,
    };
  }
}
