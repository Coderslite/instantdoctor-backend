import { env } from '../../config/env.js';
import { serviceUnavailable } from '../../lib/errors.js';
import { ProviderError } from './types.js';

export type Bank = { name: string; code: string };
export type TransferStatus = 'success' | 'pending' | 'failed' | 'reversed' | 'otp' | 'unknown';
export type TransferResult = { status: TransferStatus; transferCode: string | null; reason?: string | null };

/** Sending money out to Nigerian bank accounts (pharmacy payouts). */
export interface TransferGateway {
  listBanks(): Promise<Bank[]>;
  resolveAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }>;
  createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }>;
  /** Reusing a reference never sends twice: the provider rejects duplicates. */
  initiate(input: { amountMinor: number; recipientCode: string; reference: string; reason: string }): Promise<TransferResult>;
  /** Authoritative status; `null` when the provider has never seen the reference. */
  verify(reference: string): Promise<TransferResult | null>;
  balance(): Promise<{ currency: string; amount: number } | null>;
}

const BASE_URL = 'https://api.paystack.co';

class PaystackTransfers implements TransferGateway {
  private banks: { at: number; list: Bank[] } | null = null;

  constructor(private readonly secretKey: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // No answer at all: the outcome of a transfer is unknown, not failed.
      throw new ProviderError('paystack', 'Paystack could not be reached', err);
    }
    const body = (await res.json().catch(() => null)) as { status: boolean; message: string; data: T } | null;
    if (!res.ok || !body?.status) throw new ProviderError('paystack', body?.message ?? `HTTP ${res.status}`, undefined, res.status);
    return body.data;
  }

  async listBanks() {
    if (this.banks && Date.now() - this.banks.at < 12 * 3600_000) return this.banks.list;
    const data = await this.request<Array<{ name: string; code: string; active: boolean; is_deleted?: boolean; type?: string }>>('/bank?country=nigeria&currency=NGN&perPage=500');
    // Paystack lists some institutions twice under one code; transfers route by code, so keep one entry each.
    const byCode = new Map<string, Bank>();
    for (const bank of data) {
      if (bank.active && !bank.is_deleted && bank.type === 'nuban' && !byCode.has(bank.code)) byCode.set(bank.code, { name: bank.name, code: bank.code });
    }
    const list = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.banks = { at: Date.now(), list };
    return list;
  }

  async resolveAccount(accountNumber: string, bankCode: string) {
    const data = await this.request<{ account_name: string }>(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    return { accountName: data.account_name };
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) {
    const data = await this.request<{ recipient_code: string }>('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({ type: 'nuban', name: input.name, account_number: input.accountNumber, bank_code: input.bankCode, currency: 'NGN' }),
    });
    return { recipientCode: data.recipient_code };
  }

  async initiate(input: { amountMinor: number; recipientCode: string; reference: string; reason: string }) {
    const data = await this.request<{ status: string; transfer_code: string; reason?: string }>('/transfer', {
      method: 'POST',
      body: JSON.stringify({ source: 'balance', amount: input.amountMinor, recipient: input.recipientCode, reference: input.reference, reason: input.reason, currency: 'NGN' }),
    });
    return { status: mapStatus(data.status), transferCode: data.transfer_code ?? null, reason: data.reason ?? null };
  }

  async verify(reference: string) {
    try {
      const data = await this.request<{ status: string; transfer_code: string; reason?: string; failures?: unknown }>(`/transfer/verify/${encodeURIComponent(reference)}`);
      return { status: mapStatus(data.status), transferCode: data.transfer_code ?? null, reason: data.reason ?? null };
    } catch (err) {
      if (err instanceof ProviderError && err.isUnknownReference) return null;
      throw err;
    }
  }

  async balance() {
    const data = await this.request<Array<{ currency: string; balance: number }>>('/balance');
    const ngn = data.find((row) => row.currency === 'NGN');
    return ngn ? { currency: 'NGN', amount: ngn.balance / 100 } : null;
  }
}

function mapStatus(status: string): TransferStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'abandoned':
    case 'blocked':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'otp':
      return 'otp';
    case 'pending':
    case 'received':
    case 'queued':
    case 'processing':
      return 'pending';
    default:
      return 'unknown';
  }
}

let gateway: TransferGateway | null = null;

export function getTransferGateway(): TransferGateway {
  if (gateway) return gateway;
  if (!env.PAYSTACK_SECRET_KEY) throw serviceUnavailable('Paystack is not configured, so payouts cannot be sent');
  gateway = new PaystackTransfers(env.PAYSTACK_SECRET_KEY);
  return gateway;
}

/** Test hook: inject a fake gateway. */
export function setTransferGateway(fake: TransferGateway | null) {
  gateway = fake;
}
