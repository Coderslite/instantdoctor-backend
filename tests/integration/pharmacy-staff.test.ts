import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { pharmacies } from '../../src/db/schema/index.js';
import { newId } from '../../src/lib/ids.js';
import { signPharmacyAccessToken } from '../../src/lib/tokens.js';
import { api, resetDatabase } from '../helpers.js';

const pharmacyPortal = (pharmacyId: string) => {
  const token = signPharmacyAccessToken(pharmacyId);
  return {
    getStaff: () =>
      api().get('/api/v1/pharmacy-portal/staff').set('Authorization', `Bearer ${token}`),
    createStaff: (body: object) =>
      api()
        .post('/api/v1/pharmacy-portal/staff')
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  };
};

async function createPharmacy() {
  const id = newId();
  await db.insert(pharmacies).values({
    id,
    name: 'Test Pharmacy',
    email: `${id}@pharmacy.test`,
  });
  return id;
}

describe('pharmacy portal staff', () => {
  beforeEach(resetDatabase);

  it('lists staff for only the authenticated pharmacy', async () => {
    const pharmacyId = await createPharmacy();
    const otherPharmacyId = await createPharmacy();
    const portal = pharmacyPortal(pharmacyId);
    const created = await portal.createStaff({
      name: 'Amina James',
      email: 'amina@example.test',
      password: 'temporary-pass-1',
      phoneNumber: '+2348000000000',
      role: 'pharmacist',
    });
    await pharmacyPortal(otherPharmacyId).createStaff({
      name: 'Other Pharmacy Staff',
      email: 'other@example.test',
      password: 'temporary-pass-2',
      role: 'sales_assistant',
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Amina James',
      email: 'amina@example.test',
      role: 'pharmacist',
      status: 'active',
    });

    const response = await portal.getStaff();
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(created.body.id);
  });

  it('requires pharmacy authentication and validates staff input', async () => {
    const unauthorized = await api().get('/api/v1/pharmacy-portal/staff');
    expect(unauthorized.status).toBe(401);

    const portal = pharmacyPortal(await createPharmacy());
    const invalid = await portal.createStaff({ name: '', role: 'sales_assistant' });
    expect(invalid.status).toBe(400);
  });

  it('creates a sign-in account and enforces the account role on the server', async () => {
    const pharmacyId = await createPharmacy();
    const owner = pharmacyPortal(pharmacyId);
    const created = await owner.createStaff({
      name: 'Amina James',
      email: 'amina@example.test',
      password: 'temporary-pass-1',
      role: 'sales_assistant',
    });
    expect(created.status).toBe(201);
    expect(created.body.passwordHash).toBeUndefined();

    const login = await api().post('/api/v1/pharmacy-portal/auth/login').send({
      email: 'amina@example.test',
      password: 'temporary-pass-1',
    });
    expect(login.status).toBe(200);
    const staffToken = login.body.session.accessToken;
    const profile = await api().get('/api/v1/pharmacy-portal/me').set('Authorization', `Bearer ${staffToken}`);
    expect(profile.status).toBe(200);
    expect(profile.body.accountRole).toBe('sales_assistant');
    expect(profile.body.mustChangePassword).toBe(true);
    expect(profile.body.balance).toBeUndefined();

    const lockedDashboard = await api().get('/api/v1/pharmacy-portal/dashboard').set('Authorization', `Bearer ${staffToken}`);
    expect(lockedDashboard.status).toBe(403);
    const updatedPassword = await api().patch('/api/v1/pharmacy-portal/password')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ currentPassword: 'temporary-pass-1', newPassword: 'permanent-pass-1' });
    expect(updatedPassword.status).toBe(200);

    const activeStaffToken = updatedPassword.body.session.accessToken;
    const activeProfile = await api().get('/api/v1/pharmacy-portal/me').set('Authorization', `Bearer ${activeStaffToken}`);
    expect(activeProfile.body.mustChangePassword).toBe(false);
    const staleToken = await api().get('/api/v1/pharmacy-portal/me').set('Authorization', `Bearer ${staffToken}`);
    expect(staleToken.status).toBe(401);
    const financialDashboard = await api().get('/api/v1/pharmacy-portal/dashboard').set('Authorization', `Bearer ${activeStaffToken}`);
    expect(financialDashboard.status).toBe(403);
    const staffList = await api().get('/api/v1/pharmacy-portal/staff').set('Authorization', `Bearer ${activeStaffToken}`);
    expect(staffList.status).toBe(403);
    const deactivated = await api()
      .patch(`/api/v1/pharmacy-portal/staff/${created.body.id}`)
      .set('Authorization', `Bearer ${signPharmacyAccessToken(pharmacyId)}`)
      .send({ status: 'inactive' });
    expect(deactivated.status).toBe(200);
    const revoked = await api().get('/api/v1/pharmacy-portal/me').set('Authorization', `Bearer ${activeStaffToken}`);
    expect(revoked.status).toBe(401);
    await api()
      .patch(`/api/v1/pharmacy-portal/staff/${created.body.id}`)
      .set('Authorization', `Bearer ${signPharmacyAccessToken(pharmacyId)}`)
      .send({ status: 'active' });
    const stillRevoked = await api().get('/api/v1/pharmacy-portal/me').set('Authorization', `Bearer ${activeStaffToken}`);
    expect(stillRevoked.status).toBe(401);
  });
});
