import { env } from '../../config/env.js';

export const BRAND = {
  name: 'Instant Doctor',
  primary: '#00AEEF',
  deep: '#0A4FAD',
  ink: '#0F2744',
  body: '#334155',
  muted: '#64748B',
  border: '#E2E8F0',
  canvas: '#F1F5F9',
  panel: '#F8FAFC',
  font: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
};

export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const heading = (text: string) =>
  `<h1 style="margin:0 0 16px;font-family:${BRAND.font};font-size:22px;line-height:30px;font-weight:700;color:${BRAND.ink};">${escapeHtml(text)}</h1>`;

export const paragraph = (html: string) =>
  `<p style="margin:0 0 16px;font-family:${BRAND.font};font-size:15px;line-height:24px;color:${BRAND.body};">${html}</p>`;

export const muted = (html: string) =>
  `<p style="margin:16px 0 0;font-family:${BRAND.font};font-size:13px;line-height:20px;color:${BRAND.muted};">${html}</p>`;

export const button = (label: string, href: string) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr>
    <td style="border-radius:10px;background:${BRAND.deep};">
      <a href="${escapeHtml(href)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${BRAND.font};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;

export const codeBox = (code: string) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
  <tr>
    <td align="center" style="background:${BRAND.panel};border:1px solid ${BRAND.border};border-radius:12px;padding:22px 16px;">
      <div style="font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:10px;color:${BRAND.ink};">${escapeHtml(code)}</div>
    </td>
  </tr>
</table>`;

export const detailsTable = (rows: Array<[string, string]>) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border:1px solid ${BRAND.border};border-radius:12px;border-collapse:separate;">
  ${rows
    .map(
      ([label, value], i) => `
  <tr>
    <td style="padding:12px 16px;${i ? `border-top:1px solid ${BRAND.border};` : ''}font-family:${BRAND.font};font-size:13px;color:${BRAND.muted};width:40%;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:12px 16px;${i ? `border-top:1px solid ${BRAND.border};` : ''}font-family:${BRAND.font};font-size:14px;font-weight:600;color:${BRAND.ink};vertical-align:top;">${escapeHtml(value)}</td>
  </tr>`,
    )
    .join('')}
</table>`;

export const notice = (html: string, tone: 'info' | 'warning' = 'info') => {
  const [bg, edge] = tone === 'warning' ? ['#FFF7ED', '#F59E0B'] : ['#EFF8FF', BRAND.primary];
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
  <tr>
    <td style="background:${bg};border-left:4px solid ${edge};border-radius:8px;padding:14px 16px;font-family:${BRAND.font};font-size:14px;line-height:22px;color:${BRAND.body};">${html}</td>
  </tr>
</table>`;
};

export const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.instantdoctor.app';
export const APP_STORE = 'https://apps.apple.com/us/app/instant-doctor-telehealth/id6753775573';

const site = () => env.WEBSITE_URL.replace(/\/+$/, '');

/** Website, email and phone as links, for the footer (and a letter's letterhead). */
export function contactLinks(email: string, withPhone = true): string[] {
  const website = site();
  return [
    `<a href="${escapeHtml(website)}" style="color:${BRAND.deep};text-decoration:none;">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a>`,
    `<a href="mailto:${escapeHtml(email)}" style="color:${BRAND.deep};text-decoration:none;">${escapeHtml(email)}</a>`,
    withPhone && env.MAIL_COMPANY_PHONE ? escapeHtml(env.MAIL_COMPANY_PHONE) : null,
  ].filter((line): line is string => Boolean(line));
}

/**
 * The branded frame every email shares: brand bars, logo header, white card and
 * company footer. Tables and inline styles only, so it renders the same in Gmail,
 * Outlook and Apple Mail.
 */
export function brandedDocument(input: {
  title: string;
  preheader: string;
  /** Rows (<tr>…</tr>) for the card between the header and the footer. */
  rows: string;
  /** Right-hand side of the header (a letter's contact details); empty for normal emails. */
  headerAside?: string;
  /** Small print above the copyright line. */
  smallPrint: string;
  /** Address shown in the footer for replies. */
  contactEmail: string;
  /** Copyright year; a re-rendered sent letter keeps its own. */
  year?: number;
  /** No digits besides the body's (verification codes): phones and mail apps then pick out the code reliably. */
  numberFree?: boolean;
}): string {
  const font = BRAND.font;
  const contacts = contactLinks(input.contactEmail, !input.numberFree);
  const year = input.numberFree ? '' : `${input.year ?? new Date().getFullYear()} `;
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.canvas};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:4px;">
  <tr><td style="height:6px;background:${BRAND.deep};line-height:6px;font-size:0;border-radius:4px 4px 0 0;">&nbsp;</td></tr>
  <tr><td style="height:3px;background:${BRAND.primary};line-height:3px;font-size:0;">&nbsp;</td></tr>
  <tr>
    <td style="padding:26px 40px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="vertical-align:middle;"><img src="${escapeHtml(env.MAIL_LOGO_URL)}" width="46" height="48" alt="Instant Doctor" style="display:block;border:0;"></td>
              <td style="vertical-align:middle;padding-left:12px;">
                <div style="font-family:${font};font-size:21px;line-height:24px;font-weight:800;color:${BRAND.ink};letter-spacing:-0.3px;">${escapeHtml(BRAND.name)}</div>
                <div style="font-family:${font};font-size:11px;line-height:16px;color:${BRAND.muted};letter-spacing:0.6px;text-transform:uppercase;">Licensed doctors · Video &amp; chat · ${input.numberFree ? 'Day &amp; night' : '24/7'}</div>
              </td>
            </tr></table>
          </td>
          ${input.headerAside ? `<td align="right" style="vertical-align:middle;font-family:${font};font-size:12px;line-height:19px;color:${BRAND.muted};">${input.headerAside}</td>` : ''}
        </tr>
      </table>
    </td>
  </tr>
  <tr><td style="padding:0 40px;"><div style="border-top:1px solid ${BRAND.border};line-height:1px;font-size:0;">&nbsp;</div></td></tr>
  ${input.rows}
  <tr>
    <td style="background:${BRAND.panel};border-top:1px solid ${BRAND.border};padding:22px 40px;border-radius:0 0 4px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:top;font-family:${font};font-size:12px;line-height:19px;color:${BRAND.muted};">
          <div style="font-weight:700;color:${BRAND.ink};font-size:13px;">${escapeHtml(BRAND.name)}</div>
          ${env.MAIL_COMPANY_ADDRESS ? `${escapeHtml(env.MAIL_COMPANY_ADDRESS)}<br>` : ''}
          ${contacts.join(' &nbsp;·&nbsp; ')}
        </td>
        <td align="right" style="vertical-align:top;font-family:${font};font-size:12px;line-height:19px;white-space:nowrap;">
          <a href="${PLAY_STORE}" style="color:${BRAND.deep};text-decoration:none;font-weight:600;">Google Play</a><br>
          <a href="${APP_STORE}" style="color:${BRAND.deep};text-decoration:none;font-weight:600;">App Store</a>
        </td>
      </tr></table>
      <div style="border-top:1px solid ${BRAND.border};margin:16px 0 12px;line-height:1px;font-size:0;">&nbsp;</div>
      <div style="font-family:${font};font-size:11px;line-height:17px;color:${BRAND.muted};">
        ${input.smallPrint}<br>
        &copy; ${year}${escapeHtml(BRAND.name)}. All rights reserved.
      </div>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export interface LayoutOptions {
  preheader: string;
  body: string;
  footerNote?: string;
  /** See brandedDocument: for emails carrying a one-time code. */
  numberFree?: boolean;
}

/** Every automated email (bookings, payments, security, payouts, HMO…): the branded frame around the message. */
export function layout({ preheader, body, footerNote, numberFree }: LayoutOptions): string {
  const help = `Need help? Reply to this email or contact <a href="mailto:${escapeHtml(env.MAIL_REPLY_TO)}" style="color:${BRAND.muted};">${escapeHtml(env.MAIL_REPLY_TO)}</a>.`;
  return brandedDocument({
    title: BRAND.name,
    preheader,
    rows: `<tr><td style="padding:28px 40px 30px;">${body}</td></tr>`,
    smallPrint: footerNote ? `${footerNote} ${help}` : help,
    contactEmail: env.MAIL_REPLY_TO,
    numberFree,
  });
}

export function plainText(lines: Array<string | null | undefined | false>, { numberFree = false } = {}): string {
  return [
    ...lines.filter((line): line is string => typeof line === 'string'),
    '',
    '—',
    `${BRAND.name}${env.MAIL_COMPANY_ADDRESS ? ` · ${env.MAIL_COMPANY_ADDRESS}` : ''}`,
    `${env.WEBSITE_URL.replace(/\/+$/, '')} · ${env.MAIL_REPLY_TO}${env.MAIL_COMPANY_PHONE && !numberFree ? ` · ${env.MAIL_COMPANY_PHONE}` : ''}`,
    `Need help? Reply to this email or contact ${env.MAIL_REPLY_TO}.`,
    `© ${numberFree ? '' : `${new Date().getFullYear()} `}${BRAND.name}. All rights reserved.`,
  ].join('\n');
}
