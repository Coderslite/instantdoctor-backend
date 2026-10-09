import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { closeDatabase } from '../../src/db/client.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

describe('website blog refresh', () => {
  const token = signAdminAccessToken({ sub: newId(), role: 'admin' });
  const original = env.WEBSITE_REVALIDATE_SECRET;
  let website: ReturnType<
    typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(async () => {
    await resetDatabase();
    env.WEBSITE_REVALIDATE_SECRET = 'test-secret';
    const realFetch = globalThis.fetch;
    website = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"revalidated":true}'),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).endsWith('/api/revalidate') ? website(input, init) : realFetch(input, init),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.WEBSITE_REVALIDATE_SECRET = original;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('refreshes the website after a successful blog change', async () => {
    const res = await api()
      .post('/api/v1/admin/blog/categories')
      .set(auth(token))
      .send({ name: 'Heart Health' });
    expect(res.status).toBe(201);
    await settle();
    expect(website).toHaveBeenCalledTimes(1);
    const [url, init] = website.mock.calls[0]!;
    expect(String(url)).toBe(`${env.WEBSITE_URL.replace(/\/+$/, '')}/api/revalidate`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'x-revalidate-secret': 'test-secret' },
    });
  });

  it('does not refresh on reads or failed changes', async () => {
    await api().get('/api/v1/admin/blog/categories').set(auth(token));
    await api().post('/api/v1/admin/blog/categories').set(auth(token)).send({});
    await settle();
    expect(website).not.toHaveBeenCalled();
  });

  it('stays off without a secret', async () => {
    env.WEBSITE_REVALIDATE_SECRET = undefined;
    await api().post('/api/v1/admin/blog/categories').set(auth(token)).send({ name: 'Sleep' });
    await settle();
    expect(website).not.toHaveBeenCalled();
  });
});
