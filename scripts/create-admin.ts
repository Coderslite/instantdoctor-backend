import { eq } from 'drizzle-orm';
import { db, closeDatabase } from '../src/db/client.js';
import { admins, type AdminRole } from '../src/db/schema/index.js';
import { hashPassword } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
const role = (process.env.ADMIN_ROLE || 'admin') as AdminRole;

if (!email || !password || password.length < 8) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (minimum 8 characters) are required');
if (role !== 'admin' && role !== 'marketer') throw new Error('ADMIN_ROLE must be admin or marketer');

const passwordHash = await hashPassword(password);
const [existing] = await db.select({ id: admins.id }).from(admins).where(eq(admins.email, email)).limit(1);
if (existing) await db.update(admins).set({ name, passwordHash, role }).where(eq(admins.id, existing.id));
else await db.insert(admins).values({ id: newId(), name, email, passwordHash, role });
await closeDatabase();
