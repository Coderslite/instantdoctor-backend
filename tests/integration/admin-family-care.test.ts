import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins, appointments, familyProfiles, familySubscriptions, payments } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const DAY = 24 * 3600_000;
const at = (days: number) => new Date(Date.now() + days * DAY);

async function member(name: string, country: string, sub: Partial<typeof familySubscriptions.$inferInsert>) {
  const [firstName, lastName] = name.split(' ') as [string, string];
  const user = await createUser({ firstName, lastName, email: `${firstName.toLowerCase()}@family.test`, country, currency: country === 'NG' ? 'NGN' : 'USD' });
  const id = newId();
  await db.insert(familySubscriptions).values({ id, userId: user.id, status: 'trialing', trialStartedAt: at(-40), trialEndsAt: at(-33), ...sub });
  return { id, userId: user.id };
}
const paid = (userId: string, amount: number, currency: string, daysAgo: number) =>
  db.insert(payments).values({
    id: newId(), reference: newId(), userId, purpose: 'family_subscription', provider: 'paystack', status: 'succeeded',
    baseAmount: amount, amount, amountMinor: amount * 100, currency, paidAt: at(-daysAgo),
  });

describe('admin Family Care', () => {
  let token: string;
  beforeEach(async () => {
    await resetDatabase();
    const adminId = newId();
    await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
    token = signAdminAccessToken({ sub: adminId, role: 'admin' });
  });
  const get = (p: string) => api().get(`/api/v1/admin${p}`).set(auth(token));

  it('lists members by their real state, with family, payments, credit use and monthly income', async () => {
    // Paying, month running, ends in 3 days; two family members; their monthly visit used.
    const ada = await member('Ada Obi', 'NG', { status: 'active', currentPeriodStart: at(-27), currentPeriodEnd: at(3), consultationCreditsUsed: 1 });
    await paid(ada.userId, 5_000, 'NGN', 60);
    await paid(ada.userId, 5_000, 'NGN', 27);
    await db.insert(familyProfiles).values([
      { id: newId(), ownerUserId: ada.userId, name: 'Chidi', relationship: 'child' },
      { id: newId(), ownerUserId: ada.userId, name: 'Mama Obi', relationship: 'parent' },
    ]);
    await db.insert(appointments).values({ id: newId(), userId: ada.userId, symptoms: [], packageLabel: 'GP', startTime: at(-5), endTime: at(-5), price: 0, isPaid: true, isSubscriptionCredit: true, doctorEarning: 3_000, currency: 'NGN', status: 'completed' });
    // Paying abroad, in dollars.
    const tom = await member('Tom Reed', 'GB', { status: 'active', currentPeriodStart: at(-2), currentPeriodEnd: at(28) });
    await paid(tom.userId, 10, 'USD', 2);
    // In the free trial.
    await member('Bisi Ade', 'NG', { status: 'trialing', trialStartedAt: at(-2), trialEndsAt: at(5) });
    // Stored "active" but the paid month ran out: expired. And a trial that lapsed.
    const kemi = await member('Kemi Ola', 'NG', { status: 'active', currentPeriodStart: at(-45), currentPeriodEnd: at(-15) });
    await paid(kemi.userId, 5_000, 'NGN', 45);
    await member('Femi Ojo', 'NG', {});

    const all = await get('/family-care');
    expect(all.status).toBe(200);
    expect(all.body.summary).toEqual({ active: 2, trialing: 1, expired: 2, total: 5, everPaid: 3, endingThisWeek: 1, monthlyIncome: { NGN: 5_000, USD: 10 } });
    expect(all.body.items.map((i: { name: string; state: string }) => `${i.name}:${i.state}`).slice(0, 3)).toEqual(
      expect.arrayContaining(['Ada Obi:active', 'Tom Reed:active']),
    );
    const adaRow = all.body.items.find((i: { name: string }) => i.name === 'Ada Obi');
    expect(adaRow).toMatchObject({ state: 'active', familyMembers: 2, payments: 2, totalPaid: { NGN: 10_000 }, creditsUsed: 1, creditsPerMonth: 1, price: { amount: 5_000, currency: 'NGN' } });
    expect(all.body.items.find((i: { name: string }) => i.name === 'Tom Reed')).toMatchObject({ totalPaid: { USD: 10 }, price: { currency: 'USD' } });

    const expired = await get('/family-care?state=expired');
    expect(expired.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['Femi Ojo', 'Kemi Ola']);
    expect((await get('/family-care?state=trialing')).body.items).toHaveLength(1);
    expect((await get('/family-care?search=kemi')).body.items).toMatchObject([{ name: 'Kemi Ola', state: 'expired' }]);

    const detail = await get(`/family-care/${ada.id}`);
    expect(detail.body).toMatchObject({ name: 'Ada Obi', state: 'active', creditsUsed: 1 });
    expect(detail.body.family.map((f: { name: string }) => f.name)).toEqual(['Chidi', 'Mama Obi']);
    expect(detail.body.payments).toHaveLength(2);
    expect(detail.body.visits).toMatchObject([{ status: 'completed', doctorEarning: 3_000 }]);
    expect((await get(`/family-care/${newId()}`)).status).toBe(404);
  });
});
