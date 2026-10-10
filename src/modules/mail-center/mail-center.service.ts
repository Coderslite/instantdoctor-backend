import { and, count, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { adminEmailRecipients, adminEmails, admins, users } from '../../db/schema/index.js';
import {
  renderLetter,
  sanitizeLetterBody,
  type Letter,
  type LetterRecipient,
} from '../../integrations/mail/letterhead.js';
import { deliverReporting } from '../../integrations/mail/transport.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { MAX_RECIPIENTS, type MailSegment, type SendInput } from './mail-center.schemas.js';

type Recipient = LetterRecipient & { userId?: string | null };

/** People who can be written to: finished registration, not suspended or deleted. */
const reachable = () =>
  and(
    eq(users.registrationStatus, 'active'),
    or(
      isNull(users.accountStatus),
      and(ne(users.accountStatus, 'suspended'), ne(users.accountStatus, 'deleted')),
    ),
  );

const segmentFilter = (segment: MailSegment): SQL | undefined =>
  segment === 'patients'
    ? eq(users.role, 'user')
    : segment === 'doctors'
      ? eq(users.role, 'doctor')
      : undefined;

const userRecipient = (u: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}): Recipient => ({
  email: u.email,
  firstName: u.firstName || null,
  name: `${u.firstName} ${u.lastName}`.trim() || null,
  userId: u.id,
});

export async function audienceSize(segment: MailSegment) {
  const [row] = await db
    .select({ n: count() })
    .from(users)
    .where(and(reachable(), segmentFilter(segment)));
  return { segment, recipients: row?.n ?? 0 };
}

/** Typed addresses, picked users and a segment, merged and de-duplicated by address. */
async function resolveRecipients(input: SendInput): Promise<Recipient[]> {
  const byEmail = new Map<string, Recipient>();
  const add = (r: Recipient) => {
    const key = r.email.trim().toLowerCase();
    if (key && !byEmail.has(key)) byEmail.set(key, { ...r, email: r.email.trim() });
  };
  const columns = {
    id: users.id,
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
  };

  if (input.userIds.length) {
    const picked = await db.select(columns).from(users).where(inArray(users.id, input.userIds));
    if (picked.length !== new Set(input.userIds).size)
      throw badRequest('Some selected people no longer exist');
    picked.forEach((u) => add(userRecipient(u)));
  }
  if (input.segment) {
    const everyone = await db
      .select(columns)
      .from(users)
      .where(and(reachable(), segmentFilter(input.segment)))
      .limit(MAX_RECIPIENTS + 1);
    everyone.forEach((u) => add(userRecipient(u)));
  }
  // Typed addresses that belong to an account still get the person's name.
  const typed = input.emails.filter((e) => !byEmail.has(e.email.trim().toLowerCase()));
  if (typed.length) {
    const known = await db
      .select(columns)
      .from(users)
      .where(
        inArray(
          users.email,
          typed.map((e) => e.email.trim()),
        ),
      );
    const knownByEmail = new Map(known.map((u) => [u.email.toLowerCase(), u]));
    for (const e of typed) {
      const user = knownByEmail.get(e.email.trim().toLowerCase());
      const details = {
        title: e.title || null,
        organization: e.organization || null,
        address: e.address || null,
      };
      // A typed name or organisation wins over the account's name: it's how the letter should be addressed.
      if (e.name || e.organization)
        add({ email: e.email, name: e.name ?? null, userId: user?.id ?? null, ...details });
      else add(user ? { ...userRecipient(user), ...details } : { email: e.email, ...details });
    }
  }

  const all = [...byEmail.values()];
  if (!all.length)
    throw unprocessable(
      'NO_RECIPIENTS',
      'None of the chosen recipients have an email address we can write to',
    );
  if (all.length > MAX_RECIPIENTS) {
    throw unprocessable(
      'TOO_MANY_RECIPIENTS',
      `A letter can go to at most ${MAX_RECIPIENTS} people at once`,
    );
  }
  return all;
}

/** ID/2026/10/0007 — sequential within the month. */
async function nextReference(now = new Date()) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ n: count() })
    .from(adminEmails)
    .where(gte(adminEmails.createdAt, monthStart));
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `ID/${now.getUTCFullYear()}/${month}/${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

const letterOf = (
  input: { subject: string; body: string; signatureName: string; signatureTitle?: string | null },
  reference: string,
  date = new Date(),
): Letter => {
  const body = sanitizeLetterBody(input.body);
  if (!body.replace(/<[^>]+>/g, '').trim()) throw badRequest('Write the letter before sending');
  return {
    subject: input.subject,
    body,
    reference,
    date,
    signatureName: input.signatureName,
    signatureTitle: input.signatureTitle || null,
  };
};

const officialMail = (letter: Letter, to: Recipient, category: string) => {
  const { html, text } = renderLetter(letter, to);
  return {
    to: to.email,
    subject: letter.subject,
    html,
    text,
    category,
    from: env.MAIL_OFFICIAL_FROM,
    replyTo: env.MAIL_OFFICIAL_REPLY_TO,
  };
};

export function preview(input: {
  subject: string;
  body: string;
  signatureName: string;
  signatureTitle?: string | null;
  recipientName?: string;
  recipientEmail?: string;
  recipientTitle?: string;
  recipientOrganization?: string;
  recipientAddress?: string;
  reference?: string;
  date?: string;
}) {
  const letter: Letter = {
    subject: input.subject,
    body:
      sanitizeLetterBody(input.body) ||
      '<p style="color:#94a3b8;">Your letter will appear here.</p>',
    reference: input.reference || 'ID/PREVIEW',
    date: input.date ? new Date(input.date) : new Date(),
    signatureName: input.signatureName || 'Your name',
    signatureTitle: input.signatureTitle || null,
  };
  // An organisation with no contact name is addressed "Dear Sir/Madam", as the real letter will be.
  const name = input.recipientName?.trim() || (input.recipientOrganization ? '' : 'Ada Okafor');
  return {
    html: renderLetter(letter, {
      email: input.recipientEmail || 'recipient@example.com',
      name: name || null,
      firstName: name.split(/\s+/)[0] || null,
      title: input.recipientTitle,
      organization: input.recipientOrganization,
      address: input.recipientAddress,
    }).html,
  };
}

/** Sends the letter to the signed-in admin only, marked as a test. */
export async function sendTest(adminId: string, input: Parameters<typeof letterOf>[0]) {
  const [admin] = await db
    .select({ email: admins.email, name: admins.name })
    .from(admins)
    .where(eq(admins.id, adminId))
    .limit(1);
  if (!admin) throw notFound('Admin');
  const letter = letterOf({ ...input, subject: `[TEST] ${input.subject}` }, 'ID/TEST');
  const result = await deliverReporting(
    officialMail(letter, { email: admin.email, name: admin.name }, 'admin-letter-test'),
  );
  if (!result.ok) throw unprocessable('MAIL_FAILED', `The test could not be sent: ${result.error}`);
  return { sentTo: admin.email };
}

export async function send(adminId: string, input: SendInput) {
  const recipients = await resolveRecipients(input);
  const id = newId();
  const reference = await nextReference();
  const letter = letterOf(input, reference);
  await db.insert(adminEmails).values({
    id,
    reference,
    adminId,
    subject: letter.subject,
    body: letter.body,
    signatureName: letter.signatureName,
    signatureTitle: letter.signatureTitle,
    audience: {
      segment: input.segment ?? null,
      emails: input.emails.length,
      users: input.userIds.length,
    },
    recipientCount: recipients.length,
  });
  for (let i = 0; i < recipients.length; i += 500) {
    await db.insert(adminEmailRecipients).values(
      recipients.slice(i, i + 500).map((r) => ({
        details:
          r.organization || r.title || r.address
            ? {
                title: r.title ?? null,
                organization: r.organization ?? null,
                address: r.address ?? null,
              }
            : null,
        id: newId(),
        emailId: id,
        email: r.email,
        name: r.name ?? null,
        userId: r.userId ?? null,
      })),
    );
  }
  // Sending runs after the response; progress is visible in the history.
  void deliverAll(id, letter, recipients).catch((err: unknown) =>
    logger.error({ err, emailId: id }, 'Letter delivery crashed'),
  );
  return getEmail(id);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One message per recipient (nobody sees anyone else's address), paced for the SMTP provider. */
async function deliverAll(emailId: string, letter: Letter, recipients: Recipient[]) {
  const rows = await db
    .select({ id: adminEmailRecipients.id, email: adminEmailRecipients.email })
    .from(adminEmailRecipients)
    .where(eq(adminEmailRecipients.emailId, emailId));
  const rowByEmail = new Map(rows.map((r) => [r.email.toLowerCase(), r.id]));
  let sent = 0;
  let failed = 0;
  for (const [i, to] of recipients.entries()) {
    if (i > 0 && env.MAIL_BULK_DELAY_MS) await pause(env.MAIL_BULK_DELAY_MS);
    const result = await deliverReporting(officialMail(letter, to, 'admin-letter'));
    const rowId = rowByEmail.get(to.email.toLowerCase());
    if (rowId) {
      await db
        .update(adminEmailRecipients)
        .set(
          result.ok
            ? { status: 'sent', sentAt: new Date() }
            : { status: 'failed', error: result.error },
        )
        .where(eq(adminEmailRecipients.id, rowId));
    }
    if (result.ok) sent++;
    else failed++;
    // Keep the totals current so the admin can watch a large send progress.
    if ((i + 1) % 10 === 0 || i === recipients.length - 1) {
      await db
        .update(adminEmails)
        .set({ sentCount: sent, failedCount: failed })
        .where(eq(adminEmails.id, emailId));
    }
  }
  const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
  await db
    .update(adminEmails)
    .set({ status, sentCount: sent, failedCount: failed })
    .where(eq(adminEmails.id, emailId));
}

const summaryColumns = {
  id: adminEmails.id,
  reference: adminEmails.reference,
  subject: adminEmails.subject,
  status: adminEmails.status,
  audience: adminEmails.audience,
  recipientCount: adminEmails.recipientCount,
  sentCount: adminEmails.sentCount,
  failedCount: adminEmails.failedCount,
  createdAt: adminEmails.createdAt,
  sentBy: admins.name,
};

export async function history(query: { limit: number; offset: number }) {
  const [items, [total]] = await Promise.all([
    db
      .select(summaryColumns)
      .from(adminEmails)
      .leftJoin(admins, eq(admins.id, adminEmails.adminId))
      .orderBy(desc(adminEmails.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ n: count() }).from(adminEmails),
  ]);
  return { items, total: total?.n ?? 0, limit: query.limit, offset: query.offset };
}

export async function getEmail(id: string) {
  const [email] = await db
    .select({
      ...summaryColumns,
      body: adminEmails.body,
      signatureName: adminEmails.signatureName,
      signatureTitle: adminEmails.signatureTitle,
    })
    .from(adminEmails)
    .leftJoin(admins, eq(admins.id, adminEmails.adminId))
    .where(eq(adminEmails.id, id))
    .limit(1);
  if (!email) throw notFound('Letter');
  const recipients = await db
    .select({
      email: adminEmailRecipients.email,
      name: adminEmailRecipients.name,
      details: adminEmailRecipients.details,
      status: adminEmailRecipients.status,
      error: adminEmailRecipients.error,
      sentAt: adminEmailRecipients.sentAt,
    })
    .from(adminEmailRecipients)
    .where(eq(adminEmailRecipients.emailId, id))
    .orderBy(
      sql`FIELD(${adminEmailRecipients.status}, 'failed', 'pending', 'sent')`,
      adminEmailRecipients.email,
    )
    .limit(1000);
  return { ...email, recipients };
}
