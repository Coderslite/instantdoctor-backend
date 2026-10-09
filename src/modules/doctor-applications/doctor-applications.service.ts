import { and, count, desc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  admins,
  doctorApplications,
  doctorProfiles,
  files,
  REQUIRED_DOCTOR_DOCUMENTS,
  users,
  type DoctorApplicationDocument,
  type DoctorApplicationStatus,
  type DoctorDocumentType,
} from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import { hashPassword } from '../../lib/crypto.js';
import { affectedRows, isDuplicateKeyError } from '../../lib/db-errors.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { generateTag } from '../auth/auth.service.js';
import {
  FILE_REF_PREFIX,
  serializeFile,
  UNCLAIMED_APPLICANT_FILE,
  uploadFile,
  type IncomingFile,
} from '../files/files.service.js';
import type { SubmitApplicationInput } from './doctor-applications.schemas.js';

/** Short, human-friendly form of the application id used in emails and by support. */
export const applicationReference = (id: string) => `DA-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** Website upload of one document, before the application exists. */
export async function uploadDocument(file: IncomingFile) {
  const uploaded = await uploadFile({ kind: 'applicant', id: UNCLAIMED_APPLICANT_FILE }, 'doctor_document', file);
  return { id: uploaded.id, name: uploaded.name, contentType: uploaded.contentType, size: uploaded.size };
}

export async function submit(input: SubmitApplicationInput) {
  const [account] = await db
    .select({ registrationStatus: users.registrationStatus })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (account?.registrationStatus === 'active') {
    throw conflict(
      'EMAIL_TAKEN',
      'An Instant Doctor account already uses this email. Apply with a different email, or contact us if you already work with us.',
    );
  }
  const [open] = await db
    .select({ id: doctorApplications.id })
    .from(doctorApplications)
    .where(and(eq(doctorApplications.email, input.email), eq(doctorApplications.status, 'pending')))
    .limit(1);
  if (open) {
    throw conflict('APPLICATION_EXISTS', 'We already have an application for this email under review. We will email you once it is decided.');
  }

  const fileIds = input.documents.map((d) => d.fileId);
  if (new Set(fileIds).size !== fileIds.length) throw badRequest('Each document can only be attached once');
  const provided = new Set<DoctorDocumentType>(input.documents.map((d) => d.type));
  const missing = REQUIRED_DOCTOR_DOCUMENTS.filter((type) => !provided.has(type));
  if (missing.length) {
    throw badRequest(
      'Some required documents are missing',
      missing.map((type) => ({ path: `documents.${type}`, message: 'Required' })),
    );
  }

  const id = newId();
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    const uploads = await tx
      .select({ id: files.id, name: files.originalName })
      .from(files)
      .where(
        and(
          inArray(files.id, fileIds),
          eq(files.ownerType, 'applicant'),
          eq(files.ownerId, UNCLAIMED_APPLICANT_FILE),
          eq(files.purpose, 'doctor_document'),
          eq(files.status, 'ready'),
          isNull(files.deletedAt),
        ),
      )
      .for('update');
    if (uploads.length !== fileIds.length) {
      throw badRequest('One of your documents has expired. Please upload it again and resubmit.');
    }
    const names = new Map(uploads.map((u) => [u.id, u.name]));
    const documents: DoctorApplicationDocument[] = input.documents.map((d) => ({
      type: d.type,
      fileId: d.fileId,
      name: names.get(d.fileId) ?? null,
    }));
    await tx.insert(doctorApplications).values({
      id,
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phoneNumber: input.phoneNumber,
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      country: input.country,
      state: input.state ?? null,
      address: input.address ?? null,
      specialization: input.specialization,
      experienceYears: input.experienceYears,
      licenceNumber: input.licenceNumber,
      licensingBody: input.licensingBody,
      licenceExpiresAt: input.licenceExpiresAt ?? null,
      institution: input.institution,
      graduationYear: input.graduationYear,
      housemanship: input.housemanship ?? null,
      housemanshipYear: input.housemanshipYear ?? null,
      workplace: input.workplace ?? null,
      languages: input.languages ?? null,
      bio: input.bio ?? null,
      documents,
    });
    await tx.update(files).set({ ownerId: id }).where(inArray(files.id, fileIds));
  });

  const reference = applicationReference(id);
  void mailer.doctorApplicationReceived({ to: input.email, firstName: input.firstName, reference });
  void mailer.opsDoctorApplication({
    id,
    name: `${input.firstName} ${input.lastName}`,
    email: input.email,
    phoneNumber: input.phoneNumber,
    specialization: input.specialization,
    country: input.country,
    at: new Date(),
  });
  return { id, reference, status: 'pending' as const, email: input.email };
}

// ─── Admin review ────────────────────────────────────────────────────────────

export async function list(query: {
  status?: DoctorApplicationStatus;
  search?: string;
  limit: number;
  offset: number;
}) {
  const filters: SQL[] = [];
  if (query.status) filters.push(eq(doctorApplications.status, query.status));
  if (query.search) {
    const term = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    filters.push(
      or(
        like(doctorApplications.firstName, term),
        like(doctorApplications.lastName, term),
        like(doctorApplications.email, term),
        like(doctorApplications.specialization, term),
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const [items, [total], [pending]] = await Promise.all([
    db
      .select({
        id: doctorApplications.id,
        firstName: doctorApplications.firstName,
        lastName: doctorApplications.lastName,
        email: doctorApplications.email,
        phoneNumber: doctorApplications.phoneNumber,
        country: doctorApplications.country,
        specialization: doctorApplications.specialization,
        experienceYears: doctorApplications.experienceYears,
        status: doctorApplications.status,
        createdAt: doctorApplications.createdAt,
        reviewedAt: doctorApplications.reviewedAt,
      })
      .from(doctorApplications)
      .where(where)
      .orderBy(desc(doctorApplications.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(doctorApplications).where(where),
    db.select({ value: count() }).from(doctorApplications).where(eq(doctorApplications.status, 'pending')),
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
    .select({ application: doctorApplications, reviewerName: admins.name })
    .from(doctorApplications)
    .leftJoin(admins, eq(admins.id, doctorApplications.reviewedBy))
    .where(eq(doctorApplications.id, id))
    .limit(1);
  if (!row) throw notFound('Application');
  const { documents, ...rest } = row.application;
  const application = { ...rest, passwordHash: undefined };
  const stored = documents.length
    ? await db.select().from(files).where(inArray(files.id, documents.map((d) => d.fileId)))
    : [];
  const byId = new Map(stored.map((file) => [file.id, file]));
  return {
    ...application,
    reference: applicationReference(application.id),
    reviewerName: row.reviewerName,
    documents: await Promise.all(
      documents.map(async (document) => {
        const file = byId.get(document.fileId);
        const view = file && !file.deletedAt ? await serializeFile(file) : null;
        return {
          type: document.type,
          fileId: document.fileId,
          name: view?.name ?? document.name,
          contentType: view?.contentType ?? null,
          size: view?.size ?? null,
          url: view?.url ?? null,
        };
      }),
    ),
  };
}

type ApplicationRow = typeof doctorApplications.$inferSelect;

async function pendingForReview(executor: Pick<typeof db, 'select'>, id: string): Promise<ApplicationRow> {
  const [application] = await executor.select().from(doctorApplications).where(eq(doctorApplications.id, id)).for('update');
  if (!application) throw notFound('Application');
  if (application.status !== 'pending') {
    throw conflict('APPLICATION_REVIEWED', `This application has already been ${application.status}`);
  }
  return application;
}

/**
 * Creates the doctor account with the password chosen on the application, moves
 * the documents to it and emails the applicant how to sign in to the doctor app.
 */
export async function approve(id: string, adminId: string, note?: string | null) {
  let application: ApplicationRow | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      application = await db.transaction(async (tx) => {
        const app = await pendingForReview(tx, id);
        const [existing] = await tx
          .select({ id: users.id, registrationStatus: users.registrationStatus })
          .from(users)
          .where(eq(users.email, app.email))
          .limit(1);
        if (existing?.registrationStatus === 'active') {
          throw conflict(
            'EMAIL_TAKEN',
            'Another account already uses this email, so a doctor account cannot be created for it. Ask the applicant to apply with a different email.',
          );
        }
        // An abandoned, never-verified sign-up holds the email: it would block the new account.
        if (existing) await tx.delete(users).where(eq(users.id, existing.id));

        const userId = newId();
        const now = new Date();
        await tx.insert(users).values({
          id: userId,
          email: app.email,
          passwordHash: app.passwordHash,
          role: 'doctor',
          registrationStatus: 'active',
          accountStatus: 'active',
          firstName: app.firstName,
          lastName: app.lastName,
          phoneNumber: app.phoneNumber,
          gender: app.gender,
          dateOfBirth: app.dateOfBirth,
          country: app.country,
          address: app.address,
          otherLanguage: app.languages,
          tag: generateTag(app.firstName),
          emailVerifiedAt: now,
        });
        const licence = app.documents.find((d) => d.type === 'practising_licence');
        await tx.insert(doctorProfiles).values({
          userId,
          specialization: app.specialization,
          experienceYears: app.experienceYears,
          bio: app.bio,
          isAvailable: false,
          certificateUrl: licence ? `${FILE_REF_PREFIX}${licence.fileId}` : null,
          institution: app.institution,
          graduationYear: app.graduationYear,
          housemanship: app.housemanship,
          housemanshipYear: app.housemanshipYear,
          workAddress: app.workplace,
          homeAddress: app.address,
          registeredOn: now.toISOString().slice(0, 10),
        });
        await tx
          .update(files)
          .set({ ownerType: 'user', ownerId: userId })
          .where(and(eq(files.ownerType, 'applicant'), eq(files.ownerId, app.id)));
        const updated = await tx
          .update(doctorApplications)
          .set({ status: 'approved', reviewNote: note ?? null, reviewedBy: adminId, reviewedAt: now, userId })
          .where(and(eq(doctorApplications.id, app.id), eq(doctorApplications.status, 'pending')));
        if (affectedRows(updated) === 0) throw conflict('APPLICATION_REVIEWED', 'This application has already been reviewed');
        return { ...app, userId };
      });
      break;
    } catch (err) {
      // Referral tag collision: retry with a fresh tag.
      if (isDuplicateKeyError(err) && String((err as Error).message).includes('users_tag_uq') && attempt < 3) continue;
      if (isDuplicateKeyError(err)) throw conflict('EMAIL_TAKEN', 'Another account already uses this email');
      throw err;
    }
  }

  void mailer.doctorApplicationApproved({ to: application.email, firstName: application.firstName });
  void mailer.activity(application.userId!, 'Doctor application approved');
  return get(id);
}

export async function reject(id: string, adminId: string, reason: string) {
  const application = await db.transaction(async (tx) => {
    const app = await pendingForReview(tx, id);
    await tx
      .update(doctorApplications)
      .set({ status: 'rejected', reviewNote: reason, reviewedBy: adminId, reviewedAt: new Date() })
      .where(eq(doctorApplications.id, app.id));
    return app;
  });
  void mailer.doctorApplicationRejected({ to: application.email, firstName: application.firstName, reason });
  return get(id);
}
