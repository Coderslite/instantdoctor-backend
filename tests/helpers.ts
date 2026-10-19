import request from 'supertest';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import * as s from '../src/db/schema/index.js';
import { primeRates } from '../src/integrations/exchange-rates.js';
import { newId } from '../src/lib/ids.js';
import { signAccessToken, signAdminAccessToken } from '../src/lib/tokens.js';

export const app = createApp();
export const api = () => request(app);

const TABLES = [
  'idempotency_keys', 'doctor_ledger', 'doctor_payouts', 'doctor_payout_runs', 'hmo_activity', 'hmo_users', 'hmo_claims', 'hmo_capitation_lines', 'hmo_invoices', 'hmo_link_requests', 'hmo_enrollees', 'hmo_plan_rules', 'hmo_plans', 'hmos', 'admin_email_recipients', 'admin_emails', 'doctor_applications', 'hmo_applications', 'pharmacy_applications', 'files', 'payment_webhook_events', 'payments', 'wallet_transactions', 'notifications',
  'referrals', 'reviews', 'prescription_items', 'prescriptions', 'appointment_messages', 'report_messages', 'reports',
  'appointments', 'appointment_packages', 'order_events', 'order_issues', 'pharmacy_reviews', 'pharmacy_ledger', 'pharmacy_payouts', 'pharmacy_payout_runs', 'pharmacy_bank_accounts', 'inventory_movements', 'pos_sale_items', 'pos_sales', 'purchase_order_items', 'purchase_orders', 'suppliers', 'order_items', 'orders', 'order_checkouts', 'products',
  'pharmacy_staff', 'pharmacies', 'lab_result_files', 'lab_results', 'care_summary_shares', 'family_subscriptions', 'vital_readings', 'care_plans',
  'medication_doses', 'medications', 'family_profiles', 'service_charges', 'app_settings',
  'doctor_profiles', 'payout_accounts', 'user_medical_profiles', 'refresh_tokens', 'portal_sessions', 'admins', 'password_reset_tokens', 'otp_codes', 'auth_identities', 'users',
];

export async function resetDatabase() {
  // FOREIGN_KEY_CHECKS is per-session: run everything on one pinned connection.
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
  primeRates({ NGN: 1500, GBP: 0.8 });
}

export async function createUser(overrides: Partial<typeof s.users.$inferInsert> = {}) {
  const id = overrides.id ?? newId();
  await db.insert(s.users).values({
    id,
    email: `${id}@test.local`,
    firstName: 'Test',
    lastName: 'User',
    country: 'US',
    currency: 'USD',
    ...overrides,
  });
  return { id, token: signAccessToken({ sub: id, role: overrides.role ?? 'user' }) };
}

export async function createDoctor(overrides: Partial<typeof s.users.$inferInsert> = {}) {
  const doctor = await createUser({ role: 'doctor', lastSeenAt: new Date(), ...overrides });
  await db.insert(s.doctorProfiles).values({ userId: doctor.id, isAvailable: true, specialization: 'GP' });
  return doctor;
}

export async function createPackage(overrides: Partial<typeof s.appointmentPackages.$inferInsert> = {}) {
  const { features = s.DEFAULT_APPOINTMENT_PACKAGE_FEATURES, ...rest } = overrides;
  const id = rest.id ?? newId();
  await db.insert(s.appointmentPackages).values({
    id,
    name: 'Standard',
    type: 'standard',
    amountUsd: 10,
    durationSeconds: 3600,
    features,
    ...rest,
  });
  return id;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** An admin account with this role (the API checks the account exists and is active); returns its access token. */
export async function adminToken(role: s.AdminRole = 'admin') {
  const id = newId();
  await db.insert(s.admins).values({ id, name: `${role} admin`, email: `${id}@admin.test`, role });
  return signAdminAccessToken({ sub: id, role });
}
