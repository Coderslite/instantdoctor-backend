import type { PaymentProviderName } from '../../db/schema/payments.js';

export interface InitializeInput {
  /** Our merchant reference (unique per payment). */
  reference: string;
  amount: number;
  amountMinor: number;
  currency: string;
  customer: { email: string; name: string };
  description: string;
  metadata: Record<string, string>;
}

/** What the mobile client must do next to complete payment. */
export type ClientAction =
  | { type: 'stripe_payment_sheet'; clientSecret: string; paymentIntentId: string }
  | { type: 'redirect'; authorizationUrl: string; accessCode?: string };

export interface InitializeResult {
  providerReference: string | null;
  clientAction: ClientAction;
}

export type ProviderOutcome = 'succeeded' | 'failed' | 'pending';

export interface VerifyResult {
  outcome: ProviderOutcome;
  /** Amount actually captured, in minor units. */
  amountMinor: number;
  currency: string;
  providerReference: string | null;
  failureReason?: string;
}

export interface ParsedWebhook {
  /** Provider event id used for de-duplication. */
  eventId: string;
  eventType: string;
  /** Our merchant reference, if the event concerns a payment we created. */
  reference: string | null;
  payload: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  initialize(input: InitializeInput): Promise<InitializeResult>;
  /** Authoritative status lookup against the provider API. */
  verify(payment: { reference: string; providerReference: string | null }): Promise<VerifyResult>;
  /** Verifies the webhook signature and extracts the event. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
