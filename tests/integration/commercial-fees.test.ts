import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/client.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());
beforeEach(resetDatabase);

const adminAuth = (role: 'admin' | 'marketer' = 'admin') => ({
  Authorization: `Bearer ${signAdminAccessToken({ sub: newId(), role })}`,
});

const fees = {
  gatewayFeePercent: 0,
  orderSurchargePercent: 2,
  consultationPlatformPercent: 40,
  pharmacyPlatformPercent: 5,
  referralCommissionPercent: 10,
};

describe('admin commercial fee policy', () => {
  it('returns the legacy policy until an administrator saves rates', async () => {
    const res = await api().get('/api/v1/admin/commercial-fees').set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.fees).toEqual(fees);
  });

  it('requires an admin role to update rates and rejects invalid splits', async () => {
    await api()
      .put('/api/v1/admin/commercial-fees')
      .set(adminAuth('marketer'))
      .send(fees)
      .expect(403);

    const invalid = { ...fees, gatewayFeePercent: 20, consultationPlatformPercent: 81 };
    await api().put('/api/v1/admin/commercial-fees').set(adminAuth()).send(invalid).expect(400);
  });

  it('persists and returns the complete updated policy', async () => {
    const updated = {
      gatewayFeePercent: 1.5,
      orderSurchargePercent: 3.25,
      consultationPlatformPercent: 30,
      pharmacyPlatformPercent: 7.5,
      referralCommissionPercent: 12,
    };
    const res = await api().put('/api/v1/admin/commercial-fees').set(adminAuth()).send(updated);
    expect(res.status).toBe(200);
    expect(res.body.fees).toEqual(updated);
    const loaded = await api().get('/api/v1/admin/commercial-fees').set(adminAuth());
    expect(loaded.body.fees).toEqual(updated);
  });
});
