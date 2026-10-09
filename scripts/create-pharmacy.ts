import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { pharmacies } from '../src/db/schema/index.js';
import { hashPassword } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';

const email = process.env.PHARMACY_EMAIL?.trim().toLowerCase();
const password = process.env.PHARMACY_PASSWORD;
const name = process.env.PHARMACY_NAME?.trim() || 'Demo Pharmacy';

if (!email || !password || password.length < 8) throw new Error('PHARMACY_EMAIL and PHARMACY_PASSWORD (minimum 8 characters) are required');

const passwordHash = await hashPassword(password);
const [existing] = await db.select({ id: pharmacies.id }).from(pharmacies).where(eq(pharmacies.email, email)).limit(1);
if (existing) {
  await db.update(pharmacies).set({ name, passwordHash, status: 'active' }).where(eq(pharmacies.id, existing.id));
} else {
  await db.insert(pharmacies).values({
    id: newId(),
    name,
    email,
    passwordHash,
    phoneNumber: '+234 800 000 0000',
    address: 'Lagos, Nigeria',
    deliveryFeePerKm: 500,
    status: 'onboarding',
  });
}
await closeDatabase();
