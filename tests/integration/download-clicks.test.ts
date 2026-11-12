import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { downloadClicks } from '../../src/db/schema/index.js';
import { adminToken, api, auth, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const PIXEL = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

/** Sends a beacon the way the website does: text/plain JSON. */
const click = (body: object | string, userAgent = PIXEL) =>
  api()
    .post('/api/v1/download-clicks')
    .set('User-Agent', userAgent)
    .set('Content-Type', 'text/plain')
    .send(typeof body === 'string' ? body : JSON.stringify(body));

describe('app download clicks', () => {
  beforeEach(() => resetDatabase());

  it('records a click with its campaign, device and store, once per clickId', async () => {
    const clickId = crypto.randomUUID();
    const body = { clickId, store: 'android', utmSource: 'Google', utmMedium: 'cpc', utmCampaign: 'Lagos Q4', utmId: '123', page: '/app' };
    expect((await click(body)).body).toEqual({ counted: true });
    expect((await click(body)).body).toEqual({ counted: false });

    const rows = await db.select().from(downloadClicks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store: 'android', source: 'google', medium: 'cpc', campaign: 'Lagos Q4', campaignId: '123', page: '/app', device: 'mobile', os: 'android' });
    expect(rows[0]!.visitorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to the referring site, ignores bots and bad bodies', async () => {
    expect((await click({ store: 'ios', referrer: 'https://www.facebook.com/somepost' }, IPHONE)).body.counted).toBe(true);
    expect((await click({ store: 'ios' }, 'Googlebot/2.1')).body.counted).toBe(false);
    expect((await click({ store: 'windows-phone' })).body.counted).toBe(false);
    expect((await click('not json')).body.counted).toBe(false);

    const rows = await db.select().from(downloadClicks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store: 'ios', source: 'facebook', referrer: 'www.facebook.com', os: 'ios' });
  });

  it('reports totals, sources and campaigns, and lists clicks with filters', async () => {
    await click({ store: 'android', utmSource: 'google', utmCampaign: 'brand' });
    await click({ store: 'ios', utmSource: 'google', utmCampaign: 'brand' }, IPHONE);
    await click({ store: 'android', utmSource: 'tiktok' });
    await click({ store: 'android' });

    const token = await adminToken('marketer');
    const report = await api().get('/api/v1/admin/download-clicks/report?days=7').set(auth(token));
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({ clicks: 4, android: 3, ios: 1 });
    expect(report.body.series).toHaveLength(7);
    expect(report.body.series.reduce((n: number, d: { clicks: number }) => n + d.clicks, 0)).toBe(4);
    expect(report.body.sources[0]).toMatchObject({ source: 'google', clicks: 2, android: 1, ios: 1 });
    expect(report.body.sources).toContainEqual(expect.objectContaining({ source: 'direct', clicks: 1 }));
    expect(report.body.campaigns[0]).toMatchObject({ source: 'google', campaign: 'brand', clicks: 2 });

    const list = await api().get('/api/v1/admin/download-clicks?source=google&store=ios').set(auth(token));
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ store: 'ios', source: 'google', campaign: 'brand', imported: false });
    expect(list.body.items[0]).not.toHaveProperty('visitorHash');
    expect((await api().get('/api/v1/admin/download-clicks?source=direct').set(auth(token))).body.total).toBe(1);

    expect((await api().get('/api/v1/admin/download-clicks/report')).status).toBe(401);
  });
});
