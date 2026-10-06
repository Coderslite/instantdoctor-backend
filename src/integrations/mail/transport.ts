import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: string;
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
    from: env.MAIL_FROM,
    replyTo: env.MAIL_REPLY_TO,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    headers: { 'X-Entity-Ref-ID': `${mail.category}-${Date.now()}` },
  });
};

const logSink: MailSink = async (mail) => {
  logger.info({ to: mail.to, subject: mail.subject, category: mail.category }, `Mail (not sent, MAIL_DRIVER=log):\n${mail.text}`);
};

let sink: MailSink | undefined;

export function setMailSink(next: MailSink | undefined) {
  sink = next;
}

export async function deliver(mail: OutgoingMail): Promise<void> {
  const target = sink ?? (env.MAIL_DRIVER === 'smtp' ? smtpSink : logSink);
  try {
    await target(mail);
  } catch (err) {
    logger.error({ err, to: mail.to, category: mail.category }, 'Failed to send email');
  }
}
