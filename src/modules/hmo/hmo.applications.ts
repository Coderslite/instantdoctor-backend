import { and, count, desc, eq, like, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { admins, hmoApplications, hmos, hmoUsers, type HmoApplicationStatus } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { hashPassword } from '../../lib/crypto.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { conflict, notFound } from '../../lib/errors.js';
import { newId, randomCode } from '../../lib/ids.js';
import { adminActor, recordActivity } from './hmo.activity.js';
import type { applicationSchema, approveApplicationSchema } from './hmo.schemas.js';

/**
 * "Apply to partner" from the website. An admin reviews each application;
 * approving it creates the HMO and its first portal admin, and emails them a
 * temporary password for the HMO portal.
 */

/** Short, human-friendly form of the application id used in emails and by support. */
export const applicationReference = (id: string) => `HA-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** No look-alike characters, so it survives being read out or typed from an email. */
const temporaryPassword = () => randomCode(12, 'ACDEFGHJKMNPQRTUVWXYabcdefghijkmnpqrtuvwxy34679');

export async function submit(input: z.infer<typeof applicationSchema>) {
  const [open] = await db
    .select({ id: hmoApplications.id })
    .from(hmoApplications)
    .where(and(eq(hmoApplications.email, input.email), eq(hmoApplications.status, 'pending')))
    .limit(1);
  if (open) {
    throw conflict(
      'APPLICATION_EXISTS',
      'We already have an application from this email under review. We will email you once it is decided.',
    );
  }
  const id = newId();
  await db.insert(hmoApplications).values({
    id,
    organisation: input.organisation,
    contactName: input.contactName,
    contactRole: input.contactRole ?? null,
    email: input.email,
    phone: input.phone ?? null,
    enrollees: input.enrollees ?? null,
    services: input.services,
    message: input.message ?? null,
  });
  const reference = applicationReference(id);
  void mailer.hmoApplicationReceived({ to: input.email, name: input.contactName, organisation: input.organisation, reference });
  void mailer.opsHmoApplication({
    id,
    organisation: input.organisation,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone ?? null,
    enrollees: input.enrollees ?? null,
    services: input.services,
    at: new Date(),
  });
  return { id, reference, status: 'pending' as const, email: input.email };
}

// ─── Admin review ────────────────────────────────────────────────────────────

export async function list(query: { status?: HmoApplicationStatus; search?: string; limit: number; offset: number }) {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(hmoApplications.status, query.status));
  if (query.search) {
    const term = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    filters.push(
      or(
        like(hmoApplications.organisation, term),
        like(hmoApplications.contactName, term),
        like(hmoApplications.email, term),
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const [items, [total], [pending]] = await Promise.all([
    db
      .select()
      .from(hmoApplications)
      .where(where)
      .orderBy(desc(hmoApplications.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(hmoApplications).where(where),
    db.select({ value: count() }).from(hmoApplications).where(eq(hmoApplications.status, 'pending')),
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
    .select({ application: hmoApplications, reviewerName: admins.name, hmoName: hmos.name })
    .from(hmoApplications)
    .leftJoin(admins, eq(admins.id, hmoApplications.reviewedBy))
    .leftJoin(hmos, eq(hmos.id, hmoApplications.hmoId))
    .where(eq(hmoApplications.id, id))
    .limit(1);
  if (!row) throw notFound('Application');
  return {
    ...row.application,
    reference: applicationReference(row.application.id),
    reviewerName: row.reviewerName,
    hmoName: row.hmoName,
  };
}

type ApplicationRow = typeof hmoApplications.$inferSelect;

async function pendingForReview(executor: Pick<typeof db, 'select'>, id: string): Promise<ApplicationRow> {
  const [application] = await executor.select().from(hmoApplications).where(eq(hmoApplications.id, id)).for('update');
  if (!application) throw notFound('Application');
  if (application.status !== 'pending') {
    throw conflict('APPLICATION_REVIEWED', `This application has already been ${application.status}`);
  }
  return application;
}

/**
 * Creates the HMO (paused by default, until its plans are set up) and its first
 * portal admin with a temporary password, which is emailed to them and returned
 * once so the reviewer can pass it on if the email goes astray.
 */
export async function approve(id: string, adminId: string, input: z.infer<typeof approveApplicationSchema>) {
  const { adminName, adminEmail, note, ...hmo } = input;
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);
  const hmoId = newId();
  const portalUserId = newId();
  try {
    await db.transaction(async (tx) => {
      await pendingForReview(tx, id);
      const [taken] = await tx.select({ id: hmoUsers.id }).from(hmoUsers).where(eq(hmoUsers.email, adminEmail)).limit(1);
      if (taken) throw conflict('EMAIL_TAKEN', 'Another HMO portal account already uses this email. Choose a different email for the portal admin.');
      await tx.insert(hmos).values({ id: hmoId, ...hmo });
      await tx.insert(hmoUsers).values({
        id: portalUserId,
        hmoId,
        name: adminName,
        email: adminEmail,
        role: 'admin',
        passwordHash,
        mustChangePassword: true,
      });
      const updated = await tx
        .update(hmoApplications)
        .set({ status: 'approved', reviewNote: note ?? null, reviewedBy: adminId, reviewedAt: new Date(), hmoId })
        .where(and(eq(hmoApplications.id, id), eq(hmoApplications.status, 'pending')));
      if (affectedRows(updated) === 0) throw conflict('APPLICATION_REVIEWED', 'This application has already been reviewed');
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      if (String((err as Error).message).includes('hmos_code_uq'))
        throw conflict('HMO_CODE_TAKEN', 'Another HMO already uses that code');
      throw conflict('EMAIL_TAKEN', 'Another HMO portal account already uses this email');
    }
    throw err;
  }

  const actor = await adminActor(adminId);
  await recordActivity(hmoId, actor, {
    action: 'hmo.created',
    entityType: 'hmo',
    entityId: hmoId,
    summary: `Approved the partnership application from ${hmo.name}`,
  });
  await recordActivity(hmoId, actor, {
    action: 'team.created',
    entityType: 'user',
    entityId: portalUserId,
    summary: `Gave ${adminName} (${adminEmail}) admin access to the portal`,
  });
  void mailer.hmoApplicationApproved({
    to: adminEmail,
    name: adminName,
    organisation: hmo.name,
    email: adminEmail,
    password,
    portalUrl: env.HMO_PORTAL_URL,
  });
  return { application: await get(id), hmoId, portalAdmin: { email: adminEmail, temporaryPassword: password } };
}

export async function reject(id: string, adminId: string, reason: string) {
  const application = await db.transaction(async (tx) => {
    const app = await pendingForReview(tx, id);
    await tx
      .update(hmoApplications)
      .set({ status: 'rejected', reviewNote: reason, reviewedBy: adminId, reviewedAt: new Date() })
      .where(eq(hmoApplications.id, app.id));
    return app;
  });
  void mailer.hmoApplicationRejected({
    to: application.email,
    name: application.contactName,
    organisation: application.organisation,
    reason,
  });
  return get(id);
}
