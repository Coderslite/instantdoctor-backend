import { and, count, desc, eq, like, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  admins,
  pharmacies,
  pharmacyApplications,
  pharmacyStaff,
  type PharmacyApplicationStatus,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { hashPassword } from '../../lib/crypto.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import type { applicationSchema, approveApplicationSchema } from './pharmacy-applications.schemas.js';

/**
 * "Partner with us" from the website. An admin reviews each application;
 * approving it creates the pharmacy (onboarding, not yet visible to patients)
 * with an owner login, and emails the owner a temporary password for the
 * pharmacy portal, to be replaced on first sign-in.
 */

/** Short, human-friendly form of the application id used in emails and by support. */
export const applicationReference = (id: string) => `PA-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** No look-alike characters, so it survives being read out or typed from an email. */
const temporaryPassword = () => randomCode(12, 'ACDEFGHJKMNPQRTUVWXYabcdefghijkmnpqrtuvwxy34679');

const quietly = (what: string) => (err: unknown) => logger.error({ err }, `${what} email failed`);

export async function submit(input: z.infer<typeof applicationSchema>) {
  const [open] = await db
    .select({ id: pharmacyApplications.id })
    .from(pharmacyApplications)
    .where(and(eq(pharmacyApplications.email, input.email), eq(pharmacyApplications.status, 'pending')))
    .limit(1);
  if (open) {
    throw conflict(
      'APPLICATION_EXISTS',
      'We already have an application from this email under review. We will email you once it is decided.',
    );
  }
  const [partner] = await db.select({ id: pharmacies.id }).from(pharmacies).where(eq(pharmacies.email, input.email)).limit(1);
  if (partner) {
    throw conflict(
      'ALREADY_PARTNER',
      'A partner pharmacy already uses this email. Sign in to the pharmacy portal, or use a different email for a new pharmacy.',
    );
  }
  const id = newId();
  await db.insert(pharmacyApplications).values({ id, ...input });
  const reference = applicationReference(id);
  void mailer
    .pharmacyApplicationReceived({ to: input.email, name: input.contactName, pharmacyName: input.pharmacyName, reference })
    .catch(quietly('Pharmacy application received'));
  void mailer
    .opsPharmacyApplication({
      id,
      pharmacyName: input.pharmacyName,
      contactName: input.contactName,
      email: input.email,
      phone: input.phone,
      location: [input.address, input.city, input.state].filter(Boolean).join(', '),
      licenceNumber: input.licenceNumber ?? null,
      at: new Date(),
    })
    .catch(quietly('Ops pharmacy application'));
  return { id, reference, status: 'pending' as const, email: input.email };
}

// ─── Admin review ────────────────────────────────────────────────────────────

export async function list(query: { status?: PharmacyApplicationStatus; search?: string; limit: number; offset: number }) {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(pharmacyApplications.status, query.status));
  if (query.search) {
    const term = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    filters.push(
      or(
        like(pharmacyApplications.pharmacyName, term),
        like(pharmacyApplications.contactName, term),
        like(pharmacyApplications.email, term),
        like(pharmacyApplications.city, term),
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const [items, [total], [pending]] = await Promise.all([
    db
      .select()
      .from(pharmacyApplications)
      .where(where)
      .orderBy(desc(pharmacyApplications.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(pharmacyApplications).where(where),
    db.select({ value: count() }).from(pharmacyApplications).where(eq(pharmacyApplications.status, 'pending')),
  ]);
  return {
    items: items.map((item) => ({ ...item, reference: applicationReference(item.id) })),
    total: total?.value ?? 0,
    pendingCount: pending?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function get(id: string) {
  const [row] = await db
    .select({ application: pharmacyApplications, reviewerName: admins.name, pharmacyName: pharmacies.name })
    .from(pharmacyApplications)
    .leftJoin(admins, eq(admins.id, pharmacyApplications.reviewedBy))
    .leftJoin(pharmacies, eq(pharmacies.id, pharmacyApplications.pharmacyId))
    .where(eq(pharmacyApplications.id, id))
    .limit(1);
  if (!row) throw notFound('Application');
  return {
    ...row.application,
    reference: applicationReference(row.application.id),
    reviewerName: row.reviewerName,
    createdPharmacyName: row.pharmacyName,
  };
}

type ApplicationRow = typeof pharmacyApplications.$inferSelect;

async function pendingForReview(executor: Pick<typeof db, 'select'>, id: string): Promise<ApplicationRow> {
  const [application] = await executor
    .select()
    .from(pharmacyApplications)
    .where(eq(pharmacyApplications.id, id))
    .for('update');
  if (!application) throw notFound('Application');
  if (application.status !== 'pending') {
    throw conflict('APPLICATION_REVIEWED', `This application has already been ${application.status}`);
  }
  return application;
}

/**
 * Creates the pharmacy in onboarding (it signs in and sets up its store; an
 * admin switches it live) with the owner's temporary password, which is emailed
 * and returned once so the reviewer can pass it on if the email goes astray.
 */
export async function approve(id: string, adminId: string, input: z.infer<typeof approveApplicationSchema>) {
  const { note, ...pharmacy } = input;
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);
  const pharmacyId = newId();
  let application: ApplicationRow;
  try {
    application = await db.transaction(async (tx) => {
      const app = await pendingForReview(tx, id);
      const [owner] = await tx.select({ id: pharmacies.id }).from(pharmacies).where(eq(pharmacies.email, pharmacy.email)).limit(1);
      const [staff] = await tx.select({ id: pharmacyStaff.id }).from(pharmacyStaff).where(eq(pharmacyStaff.email, pharmacy.email)).limit(1);
      if (owner || staff)
        throw conflict('EMAIL_TAKEN', 'Another pharmacy portal account already uses this email. Choose a different sign-in email.');
      await tx.insert(pharmacies).values({
        id: pharmacyId,
        ...pharmacy,
        passwordHash,
        mustChangePassword: true,
        status: 'onboarding',
      });
      const updated = await tx
        .update(pharmacyApplications)
        .set({ status: 'approved', reviewNote: note ?? null, reviewedBy: adminId, reviewedAt: new Date(), pharmacyId })
        .where(and(eq(pharmacyApplications.id, id), eq(pharmacyApplications.status, 'pending')));
      if (affectedRows(updated) === 0) throw conflict('APPLICATION_REVIEWED', 'This application has already been reviewed');
      return app;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('EMAIL_TAKEN', 'Another pharmacy already uses this email');
    throw err;
  }
  void mailer
    .pharmacyApplicationApproved({
      to: pharmacy.email,
      name: application.contactName,
      pharmacyName: pharmacy.name,
      email: pharmacy.email,
      password,
      portalUrl: env.PHARMACY_PORTAL_URL,
    })
    .catch(quietly('Pharmacy application approved'));
  return { application: await get(id), pharmacyId, owner: { email: pharmacy.email, temporaryPassword: password } };
}

export async function reject(id: string, adminId: string, reason: string) {
  const application = await db.transaction(async (tx) => {
    const app = await pendingForReview(tx, id);
    await tx
      .update(pharmacyApplications)
      .set({ status: 'rejected', reviewNote: reason, reviewedBy: adminId, reviewedAt: new Date() })
      .where(eq(pharmacyApplications.id, app.id));
    return app;
  });
  void mailer
    .pharmacyApplicationRejected({
      to: application.email,
      name: application.contactName,
      pharmacyName: application.pharmacyName,
      reason,
    })
    .catch(quietly('Pharmacy application rejected'));
  return get(id);
}
