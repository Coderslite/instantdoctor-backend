import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appointments, labResults, payments } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { adminToken, api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const DAY = 24 * 3600_000;
const now = Date.now();
/** Lagos: the 1st of this month and the 15th of last month. */
const lagosMonth = new Date(now + 3600_000).toISOString().slice(0, 7);
const [y, m] = lagosMonth.split('-').map(Number) as [number, number];
// The 1st of last month at noon: inside the same-days-of-last-month window whatever today's date.
const lastMonthMid = new Date(Date.UTC(y, m - 2, 1, 12));
const thisMonthStart = new Date(`${lagosMonth}-01T00:30:00.000+01:00`);

describe('admin overview for investors', () => {
  beforeEach(() => resetDatabase());

  it('counts real patients, growth this month vs last, activity, doctors and paying/repeat patients', async () => {
    // Two joined last month, three this month (one used the app recently), one never finished signing up, one suspended.
    const a = await createUser({ createdAt: lastMonthMid, lastSeenAt: new Date(now - 2 * DAY) });
    const b = await createUser({ createdAt: lastMonthMid });
    const c = await createUser({ createdAt: thisMonthStart, lastSeenAt: new Date(now - DAY) });
    await createUser({ createdAt: thisMonthStart });
    await createUser({ createdAt: thisMonthStart, lastSeenAt: new Date(now - 45 * DAY) });
    await createUser({ registrationStatus: 'pending_verification' });
    await createUser({ accountStatus: 'suspended' });
    await createUser({ role: 'doctor' });

    // Patient A paid twice (consultation + lab review): repeat. B paid once. C only had a free trial.
    const visit = (userId: string, values: Partial<typeof appointments.$inferInsert>) =>
      db.insert(appointments).values({ id: newId(), userId, symptoms: [], packageLabel: 'GP', startTime: thisMonthStart, endTime: thisMonthStart, price: 5_000, isPaid: true, currency: 'NGN', status: 'completed', ...values });
    await visit(a.id, {});
    await db.insert(labResults).values({ id: newId(), userId: a.id, status: 'completed', price: 3_000, currency: 'NGN' });
    await visit(b.id, { startTime: lastMonthMid, endTime: lastMonthMid });
    await visit(c.id, { price: 0, isTrial: true });
    await db.insert(payments).values({ id: newId(), reference: newId(), userId: b.id, purpose: 'wallet_topup', provider: 'paystack', status: 'succeeded', baseAmount: 1_000, amount: 1_000, amountMinor: 100_000, currency: 'NGN' });

    const res = await api().get('/api/v1/admin/dashboard').set(auth(await adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.growth).toMatchObject({
      patients: { total: 5, thisMonth: 3, lastMonth: 2, change: 50 },
      activePatients: { total: 2, share: 40 },
      doctors: { total: 1 },
      consultations: { total: 3, thisMonth: 2, lastMonth: 1, change: 100 },
    });
    expect(res.body.growth.trend).toHaveLength(12);
    expect(res.body.growth.trend.at(-1)).toMatchObject({ month: lagosMonth, newPatients: 3, consultations: 2 });
    expect(res.body.payingPatients).toEqual({ total: 2, repeat: 1, repeatShare: 50 });
    expect(res.body).toHaveProperty('revenueThisMonth');

    // Roles without finance see growth but no money.
    const marketing = await api().get('/api/v1/admin/dashboard').set(auth(await adminToken('marketer')));
    expect(marketing.body.growth.patients.total).toBe(5);
    expect(marketing.body.payingPatients).toBeUndefined();
  });
});
