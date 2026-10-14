import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { admins } from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/ids.js';
import { signAdminAccessToken } from '../../src/lib/tokens.js';
import { api, auth, createUser, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

describe('the platform a patient uses', () => {
  beforeEach(() => resetDatabase());

  it('is recorded at each sign-in from the app header and shown on the admin profile', async () => {
    const email = 'ada@patient.test';
    const password = 'Ada-pass-12345';
    const patient = await createUser({ email, passwordHash: await hashPassword(password), registrationStatus: 'active', platform: 'android' });
    const adminId = newId();
    await db.insert(admins).values({ id: adminId, name: 'Ops', email: `${adminId}@admin.test`, role: 'admin' });
    const adminToken = signAdminAccessToken({ sub: adminId, role: 'admin' });
    const profile = async () => (await api().get(`/api/v1/admin/patients/${patient.id}`).set(auth(adminToken))).body;
    expect((await profile()).platform).toBe('android');

    // They switched to an iPhone.
    const login = await api().post('/api/v1/auth/login').set('X-Client-Platform', 'ios').send({ email, password });
    expect(login.status).toBe(200);
    expect((await profile()).platform).toBe('ios');

    // A browser or an unknown client doesn't overwrite the app platform.
    await api().post('/api/v1/auth/login').send({ email, password });
    await api().post('/api/v1/auth/login').set('X-Client-Platform', 'web').send({ email, password });
    expect((await profile()).platform).toBe('ios');
  });
});
