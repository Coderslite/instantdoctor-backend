import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { authIdentities, users } from '../../src/db/schema/index.js';
import { hashPassword, verifyPassword } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/ids.js';
import { socialSignIn } from '../../src/modules/auth/auth.service.js';
import { api, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

/** A user exactly as the Firestore migration writes them. */
async function migratedUser(password: string | null) {
  const id = 'FirebaseUid' + newId().slice(0, 17);
  await db.insert(users).values({
    id,
    email: `${id.toLowerCase()}@gmail.com`,
    firstName: 'Ada',
    lastName: 'Obi',
    passwordHash: password ? await hashPassword(password) : null,
    legacyAuth: true,
  });
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row!;
}

const login = (email: string, password: string) => api().post('/api/v1/auth/login').send({ email, password });

describe('migrated email/password accounts', () => {
  beforeEach(() => resetDatabase());
  afterEach(() => {
    vi.unstubAllGlobals();
    env.FIREBASE_WEB_API_KEY = undefined;
  });

  it('log in with their existing password and keep the same user id', async () => {
    const user = await migratedUser('OldPassword1');
    const res = await login(user.email, 'OldPassword1');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.session.accessToken).toBeTruthy();
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(after!.legacyAuth).toBe(false);
  });

  it('accept the email in any letter case', async () => {
    const user = await migratedUser('OldPassword1');
    expect((await login(user.email.toUpperCase(), 'OldPassword1')).status).toBe(200);
  });

  it('fall back to Firebase when the password was changed there after the export', async () => {
    const user = await migratedUser('StalePassword1');
    env.FIREBASE_WEB_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ localId: user.id }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await login(user.email, 'NewFirebasePassword1');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [after] = await db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword('NewFirebasePassword1', after!.passwordHash!)).toBe(true);
    expect(after!.legacyAuth).toBe(false); // Firebase is never consulted again for this user
  });

  it('reject a wrong password when Firebase also rejects it', async () => {
    const user = await migratedUser('OldPassword1');
    env.FIREBASE_WEB_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 400 })));
    const res = await login(user.email, 'WrongPassword1');
    expect(res.status).toBe(401);
  });

  it('do not trust a Firebase success for a different account', async () => {
    const user = await migratedUser('OldPassword1');
    env.FIREBASE_WEB_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ localId: 'someone-else' }), { status: 200 })));
    expect((await login(user.email, 'Whatever123')).status).toBe(401);
  });
});

describe('migrated Google / Apple accounts', () => {
  beforeEach(() => resetDatabase());

  it('sign in to the same account via the provider uid imported from Firebase Auth', async () => {
    const user = await migratedUser(null);
    await db.insert(authIdentities).values({ id: newId(), userId: user.id, provider: 'google', providerUserId: 'google-sub-123' });

    const result = await socialSignIn(
      { provider: 'google', providerUserId: 'google-sub-123', email: 'changed@gmail.com', emailVerified: true },
      {},
    );
    expect(result.user.id).toBe(user.id);
    expect(result.isNewUser).toBe(false);
  });

  it('link by verified email when no identity was imported', async () => {
    const user = await migratedUser(null);
    const result = await socialSignIn(
      { provider: 'apple', providerUserId: 'apple-sub-9', email: user.email, emailVerified: true },
      {},
    );
    expect(result.user.id).toBe(user.id);
    const links = await db.select().from(authIdentities).where(eq(authIdentities.userId, user.id));
    expect(links).toHaveLength(1);
  });

  it('cannot use a password (social-only accounts have none)', async () => {
    const user = await migratedUser(null);
    expect((await login(user.email, 'anything123')).status).toBe(401);
  });
});
