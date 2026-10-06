import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';
import { fromMinorUnits } from '../../lib/money.js';
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

interface PaystackTransaction {
  id?: number;
  status: string;
  amount: number;
  currency: string;
  reference?: string;
  gateway_response?: string;
}

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
      throw new ProviderError('paystack', body?.message ?? `HTTP ${res.status}`, undefined, res.status);
    }
    return body.data;
  }

  async initialize(input: InitializeInput): Promise<InitializeResult> {
    if (!SUPPORTED_CURRENCIES.has(input.currency)) {
      throw unprocessable('CURRENCY_NOT_SUPPORTED', `Paystack does not support ${input.currency}`);
    }
    if (input.method === 'bank_transfer') {
      const expiresAt = input.transferExpiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const data = await this.request<{
        reference: string;
        status: string;
        display_text?: string;
        account_name?: string;
        account_number?: string;
        bank?: { name?: string };
        account_expires_at?: string;
      }>('/charge', {
        method: 'POST',
        body: JSON.stringify({
          email: input.customer.email,
          amount: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
          metadata: { ...input.metadata, description: input.description },
          bank_transfer: { account_expires_at: expiresAt },
        }),
      });
      if (
        data.status !== 'pending_bank_transfer' ||
        !data.account_name ||
        !data.account_number ||
        !data.bank?.name ||
        !data.account_expires_at
      ) {
        throw new ProviderError('paystack', 'Paystack did not return bank-transfer account details');
      }
      const collectAmountMinor = await this.expectedTransferAmount(input.reference, input.amountMinor);
      return {
        providerReference: data.reference,
        collectAmountMinor,
        clientAction: {
          type: 'bank_transfer',
          accountName: data.account_name,
          accountNumber: data.account_number,
          bankName: data.bank.name,
          expiresAt: data.account_expires_at,
          displayText: data.display_text,
          amount: fromMinorUnits(collectAmountMinor, input.currency),
        },
      };
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
          channels: ['card'],
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

  private async expectedTransferAmount(reference: string, requestedMinor: number): Promise<number> {
    try {
      const data = await this.request<PaystackTransaction>(`/transaction/verify/${encodeURIComponent(reference)}`);
      return data.amount > requestedMinor ? data.amount : requestedMinor;
    } catch {
      return requestedMinor;
    }
  }

  async verify(payment: { reference: string }): Promise<VerifyResult> {
    const reference = encodeURIComponent(payment.reference);
    let data: PaystackTransaction;
    try {
      data = await this.request<PaystackTransaction>(`/transaction/verify/${reference}`);
    } catch (err) {
      if (!(err instanceof ProviderError && err.isUnknownReference)) throw err;
      const pending: VerifyResult = { outcome: 'pending', amountMinor: 0, currency: '', providerReference: null };
      try {
        data = await this.request<PaystackTransaction>(`/charge/${reference}`);
      } catch (chargeErr) {
        if (chargeErr instanceof ProviderError && chargeErr.isUnknownReference) return pending;
        throw chargeErr;
      }
      if (data.status !== 'success' || !data.amount || !data.currency) return pending;
      data = { ...data, reference: data.reference ?? payment.reference };
    }
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
      providerReference: data.id ? String(data.id) : payment.reference,
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
