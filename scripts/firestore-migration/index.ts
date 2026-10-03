/**
 * One-off Firestore -> MySQL migration.
 *
 *   npm run migrate:firestore -- --dry-run                    # transform + report, no writes
 *   npm run migrate:firestore                                 # write to the local DB
 *   npm run migrate:firestore:live -- --confirm-live          # write to the live DB
 *
 * Re-running before cutover acts as a delta sync. Do not re-run after the new
 * API is live: Firestore values would overwrite newer SQL data (credentials
 * of users who already signed in to the new API are always preserved).
 */
import { writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { closeDatabase, databaseConfig, databaseLabel, db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { MigrationReport } from './report.js';
import { readAuthUsers, readCollection, readSubcollection } from './source.js';
import * as t from './transformers.js';
import { upsert } from './writer.js';

const dryRun = process.argv.includes('--dry-run');
const report = new MigrationReport();
const refs = t.emptyRefs();

function log(message: string) {
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
}

async function write<T extends Parameters<typeof upsert>[0]>(
  name: string,
  table: T,
  rows: Array<T['$inferInsert']>,
  sourceCount: number,
  overrides?: Parameters<typeof upsert<T>>[2],
) {
  report.source(name, sourceCount);
  if (!dryRun) await upsert(table, rows, overrides);
  report.written(name, rows.length);
  log(`${dryRun ? '[dry-run] ' : ''}${name}: ${rows.length}/${sourceCount}`);
}

async function main() {
  log(`Target database: ${databaseLabel}`);
  if (databaseConfig.target === 'live' && !dryRun && !process.argv.includes('--confirm-live')) {
    throw new Error('Refusing to write to the LIVE database without --confirm-live (or use --dry-run)');
  }
  log(`Starting Firestore migration${dryRun ? ' (DRY RUN — no writes)' : ''}`);

  // ── Read everything up front (the dataset is small; keeps the run consistent) ──
  const collections = [
    'Users', 'Administrator', 'Settings', 'AppConfig', 'Currencies', 'Charges', 'ZegoCloud',
    'AppointmentPricing', 'Appointments', 'Prescription', 'Reviews', 'Reports', 'Pharmacies',
    'ProductCategories', 'Products', 'Orders', 'LabResults', 'MedicationTracker',
    'HealthTipsCategory', 'HealthTips', 'Notification', 'AnonymousQuestions', 'Referrals',
    'Transactions', 'Withdrawals', 'Waitlist',
  ];
  const [authUsers, loaded] = await Promise.all([readAuthUsers(), Promise.all(collections.map(readCollection))]);
  const src = Object.fromEntries(collections.map((name, i) => [name, loaded[i]!]));
  const [chargePackages, conversations, reportConversations, tipViews, tipLikes] = await Promise.all([
    readSubcollection('AppointmentCharges', 'packages'),
    readSubcollection('Appointments', 'conversation'),
    readSubcollection('Reports', 'conversation'),
    readSubcollection('HealthTips', 'views'),
    readSubcollection('HealthTips', 'likes'),
  ]);
  const c = (name: string) => src[name] ?? [];
  log(`Loaded ${Object.values(src).reduce((n, d) => n + d.length, 0)} documents and ${authUsers.length} auth users`);

  // ── Users (credentials hashed; never stored in plaintext) ──
  log('Hashing credentials (bcrypt) — this takes a minute');
  const authById = new Map(authUsers.map((u) => [u.uid, u]));
  const userBundle = await t.transformUsers(c('Users'), authById, refs, report);
  await write('users', schema.users, userBundle.users, c('Users').length, {
    // Keep credentials of users who have already signed in to the new API.
    passwordHash: sql.raw('IF(`legacy_auth`, VALUES(`password_hash`), `password_hash`)'),
    legacyAuth: sql.raw('`legacy_auth`'),
  });
  await write('user_medical_profiles', schema.userMedicalProfiles, userBundle.medical, userBundle.users.length);
  await write('doctor_profiles', schema.doctorProfiles, userBundle.doctors, userBundle.doctors.length);
  await write('payout_accounts', schema.payoutAccounts, userBundle.payouts, userBundle.payouts.length);
  await write('saved_locations', schema.savedLocations, userBundle.savedLocations, userBundle.savedLocations.length);
  await write('auth_identities', schema.authIdentities, t.transformAuthIdentities(authUsers, refs, report), authUsers.length);
  await write('admins', schema.admins, await t.transformAdmins(c('Administrator'), report), c('Administrator').length);

  // ── Platform configuration ──
  await write('app_settings', schema.appSettings, t.transformSettings(c('Settings'), c('AppConfig')), c('Settings').length + c('AppConfig').length);
  await write('currencies', schema.currencies, t.transformCurrencies(c('Currencies')), c('Currencies').length);
  await write('service_charges', schema.serviceCharges, t.transformCharges(c('Charges')), c('Charges').length);
  await write('video_call_credentials', schema.videoCallCredentials, t.transformZego(c('ZegoCloud')), c('ZegoCloud').length);
  await write('appointment_packages', schema.appointmentPackages, t.transformPackages(c('AppointmentPricing'), refs, report), c('AppointmentPricing').length);
  await write('appointment_charge_packages', schema.appointmentChargePackages, t.transformChargePackages(chargePackages), chargePackages.length);

  // ── Appointments ──
  await write('appointments', schema.appointments, t.transformAppointments(c('Appointments'), refs, report), c('Appointments').length);
  await write('appointment_messages', schema.appointmentMessages, t.transformAppointmentMessages(conversations, refs, report), conversations.length);
  await write('prescriptions', schema.prescriptions, t.transformPrescriptions(c('Prescription'), refs, report), c('Prescription').length);
  await write('reviews', schema.reviews, t.transformReviews(c('Reviews'), refs, report), c('Reviews').length);
  await write('reports', schema.reports, t.transformReports(c('Reports'), refs, report), c('Reports').length);
  await write('report_messages', schema.reportMessages, t.transformReportMessages(reportConversations, refs, report), reportConversations.length);

  // ── Pharmacy ──
  await write('pharmacies', schema.pharmacies, await t.transformPharmacies(c('Pharmacies'), refs, report), c('Pharmacies').length);
  await write('product_categories', schema.productCategories, t.transformProductCategories(c('ProductCategories'), refs), c('ProductCategories').length);
  await write('products', schema.products, t.transformProducts(c('Products'), refs, report), c('Products').length);
  const { orders, items } = t.transformOrders(c('Orders'), refs, report);
  await write('orders', schema.orders, orders, c('Orders').length);
  await write('order_items', schema.orderItems, items, items.length);

  // ── Health ──
  const lab = t.transformLabResults(c('LabResults'), refs, report);
  await write('lab_results', schema.labResults, lab.results, c('LabResults').length);
  await write('lab_result_files', schema.labResultFiles, lab.files, lab.files.length);
  const med = t.transformMedications(c('MedicationTracker'), refs, report);
  await write('medications', schema.medications, med.meds, c('MedicationTracker').length);
  await write('medication_doses', schema.medicationDoses, med.doses, med.doses.length);

  // ── Content & engagement ──
  await write('health_tip_categories', schema.healthTipCategories, t.transformHealthTipCategories(c('HealthTipsCategory'), refs), c('HealthTipsCategory').length);
  await write('health_tips', schema.healthTips, t.transformHealthTips(c('HealthTips'), refs, report), c('HealthTips').length);
  await write('health_tip_views', schema.healthTipViews, t.transformHealthTipInteractions(tipViews, refs, report, 'health_tip_views'), tipViews.length);
  await write('health_tip_likes', schema.healthTipLikes, t.transformHealthTipInteractions(tipLikes, refs, report, 'health_tip_likes'), tipLikes.length);
  await write('notifications', schema.notifications, t.transformNotifications(c('Notification'), refs, report), c('Notification').length);
  await write('anonymous_questions', schema.anonymousQuestions, t.transformAnonymous(c('AnonymousQuestions'), refs, report), c('AnonymousQuestions').length);
  await write('referrals', schema.referrals, t.transformReferrals(c('Referrals'), refs, report), c('Referrals').length);
  await write('wallet_transactions', schema.walletTransactions, t.transformTransactions(c('Transactions'), refs, report), c('Transactions').length);
  await write('withdrawals', schema.withdrawals, t.transformWithdrawals(c('Withdrawals'), refs, report), c('Withdrawals').length);
  await write('waitlist_entries', schema.waitlistEntries, t.transformWaitlist(c('Waitlist'), refs, report), c('Waitlist').length);

  // ── Verify: every written table holds at least what we wrote ──
  if (!dryRun) {
    const mismatches: string[] = [];
    for (const [table, counts] of Object.entries(report.tables)) {
      const [rows] = (await db.execute(sql.raw(`SELECT COUNT(*) AS n FROM \`${table}\``))) as unknown as [Array<{ n: number }>];
      const actual = Number(rows[0]?.n ?? 0);
      if (actual < counts.written) mismatches.push(`${table}: expected >= ${counts.written}, found ${actual}`);
    }
    if (mismatches.length) throw new Error(`Verification failed:\n${mismatches.join('\n')}`);
    log('Verification passed: row counts match');
  }

  const file = `migration-report${dryRun ? '-dry-run' : ''}-${Date.now()}.json`;
  await writeFile(file, JSON.stringify(report, null, 2));
  log(`Done. ${report.skipped.length} skipped, ${report.warnings.length} warnings. Report: ${file}`);
}

main()
  .catch((err) => {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
