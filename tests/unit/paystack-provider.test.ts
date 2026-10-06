import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaystackProvider } from '../../src/integrations/payments/paystack.provider.js';
import type { InitializeInput } from '../../src/integrations/payments/types.js';

const input = (overrides: Partial<InitializeInput> = {}): InitializeInput => ({
  reference: 'IDP_20261004_ABCDEFGHJK',
  amount: 7500,
  amountMinor: 750_000,
  currency: 'NGN',
  customer: { email: 'ada@example.com', name: 'Ada Obi' },
  description: 'Consultation',
  metadata: { purpose: 'appointment' },
  method: 'card',
  ...overrides,
});

/** Captures the request and replies with a Paystack-shaped body. */
function mockPaystack(data: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return () => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
  };
}

describe('PaystackProvider', () => {
  const provider = new PaystackProvider('sk_test_x', 'https://example.com/done');
  afterEach(() => vi.unstubAllGlobals());

  it('card: opens Paystack checkout restricted to cards', async () => {
    const sent = mockPaystack({ authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'r' });
    const result = await provider.initialize(input());
    const { url, body } = sent();
    expect(url).toBe('https://api.paystack.co/transaction/initialize');
    expect(body).toMatchObject({ amount: 750_000, currency: 'NGN', reference: 'IDP_20261004_ABCDEFGHJK', channels: ['card'] });
    expect(result.clientAction).toEqual({ type: 'redirect', authorizationUrl: 'https://checkout.paystack.com/abc', accessCode: 'abc' });
  });

  it('bank transfer: creates a Pay-with-Transfer charge and shows the amount Paystack will collect', async () => {
    const expiresAt = '2026-10-04T12:30:00.000Z';
    const calls: Array<{ path: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : null });
        const data = path === '/charge'
          ? {
              reference: 'IDP_20261004_ABCDEFGHJK',
              status: 'pending_bank_transfer',
              display_text: 'Please make a transfer to the account specified',
              account_name: 'PAYSTACK CHECKOUT',
              account_number: '9933586044',
              bank: { slug: 'titan-paystack', name: 'Paystack-Titan', id: 1 },
              account_expires_at: expiresAt,
            }
          : { status: 'ongoing', amount: 761_418, currency: 'NGN', reference: 'IDP_20261004_ABCDEFGHJK' };
        return new Response(JSON.stringify({ status: true, message: 'ok', data }), { status: 200 });
      }),
    );

    const result = await provider.initialize(input({ method: 'bank_transfer', transferExpiresAt: expiresAt }));

    expect(calls.map((c) => c.path)).toEqual(['/charge', '/transaction/verify/IDP_20261004_ABCDEFGHJK']);
    expect(calls[0]!.body).toMatchObject({
      email: 'ada@example.com',
      amount: 750_000,
      reference: 'IDP_20261004_ABCDEFGHJK',
      bank_transfer: { account_expires_at: expiresAt },
    });
    expect(result.collectAmountMinor).toBe(761_418);
    expect(result.clientAction).toEqual({
      type: 'bank_transfer',
      accountName: 'PAYSTACK CHECKOUT',
      accountNumber: '9933586044',
      bankName: 'Paystack-Titan',
      expiresAt,
      displayText: 'Please make a transfer to the account specified',
      amount: 7614.18,
    });
  });

  it('bank transfer: falls back to the requested amount if Paystack cannot report its total', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).pathname === '/charge'
          ? new Response(
              JSON.stringify({
                status: true,
                message: 'ok',
                data: {
                  reference: 'r',
                  status: 'pending_bank_transfer',
                  account_name: 'PAYSTACK CHECKOUT',
                  account_number: '1',
                  bank: { name: 'Paystack-Titan' },
                  account_expires_at: '2026-10-04T12:30:00.000Z',
                },
              }),
              { status: 200 },
            )
          : new Response('upstream error', { status: 502 }),
      ),
    );
    const result = await provider.initialize(input({ method: 'bank_transfer' }));
    expect(result.collectAmountMinor).toBe(750_000);
  });

  it('verify: a pending-charge check reporting "transfer credit request pending" is still pending', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/transaction/verify/')
          ? new Response(JSON.stringify({ status: false, message: 'Transaction reference not found.' }), { status: 400 })
          : new Response(
              JSON.stringify({
                status: true,
                message: 'Reference check successful',
                data: { status: 'failed', amount: null, message: 'transfer credit request pending' },
              }),
              { status: 200 },
            ),
      ),
    );
    expect((await provider.verify({ reference: 'IDP_REF' })).outcome).toBe('pending');
  });

  it('verify: an "ongoing" transfer awaiting money is pending', async () => {
    mockPaystack({ id: 1, status: 'ongoing', amount: 10_153, currency: 'NGN', reference: 'IDP_REF', gateway_response: 'incorrect amount sent' });
    expect((await provider.verify({ reference: 'IDP_REF' })).outcome).toBe('pending');
  });

  it('verify: a transfer awaiting money falls back to the pending-charge check', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/transaction/verify/')) {
          return new Response(JSON.stringify({ status: false, message: 'Transaction reference not found.' }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            status: true,
            message: 'ok',
            data: { status: 'pending_bank_transfer', amount: 750_000, currency: 'NGN', reference: 'IDP_REF' },
          }),
          { status: 200 },
        );
      }),
    );
    const result = await provider.verify({ reference: 'IDP_REF' });
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/transaction/verify/IDP_REF', '/charge/IDP_REF']);
    expect(result.outcome).toBe('pending');
  });

  it('verify: a transfer that has landed reads as succeeded from the charge check', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/transaction/verify/')
          ? new Response(JSON.stringify({ status: false, message: 'Transaction reference not found.' }), { status: 400 })
          : new Response(
              JSON.stringify({ status: true, message: 'ok', data: { id: 9, status: 'success', amount: 750_000, currency: 'NGN', reference: 'IDP_REF' } }),
              { status: 200 },
            ),
      ),
    );
    expect(await provider.verify({ reference: 'IDP_REF' })).toMatchObject({ outcome: 'succeeded', amountMinor: 750_000, providerReference: '9' });
  });

  it('verify: unknown everywhere means the customer has not paid yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/transaction/verify/')
          ? new Response(JSON.stringify({ status: false, message: 'Transaction reference not found.' }), { status: 400 })
          : new Response(JSON.stringify({ status: false, message: 'Transaction reference is invalid' }), { status: 400 }),
      ),
    );
    expect((await provider.verify({ reference: 'IDP_REF' })).outcome).toBe('pending');
  });

  it('verify: other Paystack errors are not mistaken for "not paid yet"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 401 })),
    );
    await expect(provider.verify({ reference: 'IDP_REF' })).rejects.toThrow(/Invalid key/);
  });

  it('bank transfer: fails clearly if Paystack does not issue an account', async () => {
    mockPaystack({ reference: 'r', status: 'failed' });
    await expect(provider.initialize(input({ method: 'bank_transfer' }))).rejects.toThrow(/bank-transfer account details/);
  });
});
