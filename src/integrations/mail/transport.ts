import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: string;
  /** Overrides MAIL_FROM / MAIL_REPLY_TO (e.g. official letters from contact@). */
  from?: string;
  replyTo?: string;
}

export type MailSink = (mail: OutgoingMail) => Promise<void>;

let transporter: Transporter | undefined;

function smtp(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    pool: true,
    maxConnections: 3,
  });
  return transporter;
}

const smtpSink: MailSink = async (mail) => {
  await smtp().sendMail({
    from: mail.from ?? env.MAIL_FROM,
    replyTo: mail.replyTo ?? env.MAIL_REPLY_TO,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: { 'X-Entity-Ref-ID': `${mail.category}-${Date.now()}` },
  });
};

const logSink: MailSink = async (mail) => {
  logger.info(
    { to: mail.to, subject: mail.subject, category: mail.category },
    `Mail (not sent, MAIL_DRIVER=log):\n${mail.text}`,
  );
};

let sink: MailSink | undefined;

export function setMailSink(next: MailSink | undefined) {
  sink = next;
}

/** Sends a message; failures are logged, never thrown. */
export async function deliver(mail: OutgoingMail): Promise<void> {
  await deliverReporting(mail);
}

/** Like deliver, but also returns the failure reason (for per-recipient send logs). */
export async function deliverReporting(
  mail: OutgoingMail,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = sink ?? (env.MAIL_DRIVER === 'smtp' ? smtpSink : logSink);
  try {
    await target(mail);
    return { ok: true };
  } catch (err) {
    logger.error({ err, to: mail.to, category: mail.category }, 'Failed to send email');
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 500) : 'Unknown error' };
  }
}
