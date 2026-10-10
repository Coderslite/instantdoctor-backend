import sanitizeHtml from 'sanitize-html';
import { env } from '../../config/env.js';
import { BRAND, escapeHtml } from './layout.js';

/**
 * Official correspondence from the admin Mail centre: letterhead with logo and
 * contact details, reference and date, subject line, salutation, body,
 * signature block and a company footer. Tables and inline styles only, so it
 * renders the same in Gmail, Outlook and Apple Mail.
 */

const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.instantdoctor.app';
const APP_STORE = 'https://apps.apple.com/us/app/instant-doctor-telehealth/id6753775573';
const font = BRAND.font;

const bodyStyles: Record<string, string> = {
  p: `margin:0 0 14px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};`,
  h2: `margin:22px 0 10px;font-family:${font};font-size:18px;line-height:26px;font-weight:700;color:${BRAND.ink};`,
  h3: `margin:18px 0 8px;font-family:${font};font-size:16px;line-height:24px;font-weight:700;color:${BRAND.ink};`,
  h4: `margin:16px 0 6px;font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};`,
  ul: `margin:0 0 14px;padding-left:22px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};`,
  ol: `margin:0 0 14px;padding-left:22px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};`,
  li: 'margin:0 0 6px;',
  a: `color:${BRAND.deep};text-decoration:underline;`,
  blockquote: `margin:0 0 14px;padding:10px 16px;border-left:4px solid ${BRAND.primary};background:${BRAND.panel};color:${BRAND.body};`,
  hr: `border:0;border-top:1px solid ${BRAND.border};margin:20px 0;`,
  img: 'max-width:100%;height:auto;border:0;',
  table: `border-collapse:collapse;margin:0 0 14px;font-family:${font};font-size:14px;`,
  th: `border:1px solid ${BRAND.border};padding:8px 10px;background:${BRAND.panel};text-align:left;color:${BRAND.ink};`,
  td: `border:1px solid ${BRAND.border};padding:8px 10px;color:${BRAND.body};vertical-align:top;`,
};

const LETTER_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'a',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'span',
];

/** Cleans editor HTML for email: safe tags only, editor classes dropped, inline styles applied. */
export function sanitizeLetterBody(html: string): string {
  // Pass 1: strip anything unsafe; of the author's styles only text alignment survives.
  const clean = sanitizeHtml(html, {
    allowedTags: LETTER_TAGS,
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
  });
  // Pass 2: add the letter's email-safe inline styles (no style filtering here, they are ours).
  return sanitizeHtml(clean, {
    allowedTags: LETTER_TAGS,
    allowedAttributes: {
      a: ['href', 'target', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      td: ['colspan', 'rowspan', 'style'],
      th: ['colspan', 'rowspan', 'style'],
      '*': ['style'],
    },
    transformTags: Object.fromEntries(
      Object.entries(bodyStyles).map(([tag, style]) => [
        tag,
        (tagName: string, attribs: Record<string, string>) => ({
          tagName,
          attribs: {
            ...attribs,
            style: `${style}${attribs.style ?? ''}`,
            ...(tag === 'a' ? { target: '_blank' } : {}),
          },
        }),
      ]),
    ),
  }).trim();
}

export interface LetterRecipient {
  email: string;
  name?: string | null;
  firstName?: string | null;
  /** For letters to organisations (HMOs, partners): printed as the recipient address block. */
  title?: string | null;
  organization?: string | null;
  address?: string | null;
}

/** "Name, Title, Organisation, Address" lines above the salutation, as in a printed business letter. */
function addressLines(to: LetterRecipient): string[] {
  if (!to.organization?.trim() && !to.address?.trim() && !to.title?.trim()) return [];
  return [to.name, to.title, to.organization, ...(to.address ?? '').split(/\r?\n/)]
    .map((line) => line?.trim() ?? '')
    .filter(Boolean);
}

export interface Letter {
  subject: string;
  /** Already sanitised with sanitizeLetterBody. */
  body: string;
  reference: string;
  date: Date;
  signatureName: string;
  signatureTitle?: string | null;
}

/** {{firstName}}, {{name}} and {{email}} in the body become the recipient's details. */
function personalise(html: string, to: LetterRecipient) {
  const firstName = to.firstName?.trim() || to.name?.trim().split(/\s+/)[0] || '';
  const values: Record<string, string> = {
    organization: to.organization?.trim() ?? '',
    firstname: firstName,
    name: to.name?.trim() || firstName,
    email: to.email,
  };
  return html.replace(/\{\{\s*(firstName|name|email|organization)\s*\}\}/gi, (_m, key: string) =>
    escapeHtml(values[key.toLowerCase()] ?? ''),
  );
}

const formatDate = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  }).format(date);

const salutationName = (to: LetterRecipient) => to.name?.trim() || to.firstName?.trim() || '';

export function renderLetter(letter: Letter, to: LetterRecipient): { html: string; text: string } {
  const website = env.WEBSITE_URL.replace(/\/+$/, '');
  const contactEmail = env.MAIL_OFFICIAL_REPLY_TO;
  const greetingName = salutationName(to);
  const body = personalise(letter.body, to);
  const contactLines = [
    `<a href="${escapeHtml(website)}" style="color:${BRAND.deep};text-decoration:none;">${escapeHtml(website.replace(/^https?:\/\//, ''))}</a>`,
    `<a href="mailto:${escapeHtml(contactEmail)}" style="color:${BRAND.deep};text-decoration:none;">${escapeHtml(contactEmail)}</a>`,
    env.MAIL_COMPANY_PHONE ? escapeHtml(env.MAIL_COMPANY_PHONE) : null,
  ].filter(Boolean);
  const year = letter.date.getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(letter.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(letter.subject)} — ${escapeHtml(BRAND.name)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
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
                <div style="font-family:${font};font-size:11px;line-height:16px;color:${BRAND.muted};letter-spacing:0.6px;text-transform:uppercase;">Licensed doctors · Video &amp; chat · 24/7</div>
              </td>
            </tr></table>
          </td>
          <td align="right" style="vertical-align:middle;font-family:${font};font-size:12px;line-height:19px;color:${BRAND.muted};">${contactLines.join('<br>')}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td style="padding:0 40px;"><div style="border-top:1px solid ${BRAND.border};line-height:1px;font-size:0;">&nbsp;</div></td></tr>
  <tr>
    <td style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${font};font-size:12px;color:${BRAND.muted};">Ref: <span style="color:${BRAND.ink};font-weight:600;">${escapeHtml(letter.reference)}</span></td>
        <td align="right" style="font-family:${font};font-size:12px;color:${BRAND.muted};">${escapeHtml(formatDate(letter.date))}</td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 40px 8px;">
      ${addressLines(to).length ? `<p style="margin:0 0 22px;font-family:${font};font-size:14px;line-height:21px;color:${BRAND.ink};">${addressLines(to).map(escapeHtml).join('<br>')}</p>` : ''}
      <p style="margin:0 0 18px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};">Dear ${escapeHtml(greetingName || 'Sir/Madam')},</p>
      <p style="margin:0 0 18px;font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};text-decoration:underline;text-underline-offset:3px;">${escapeHtml(letter.subject.toUpperCase())}</p>
      ${body}
    </td>
  </tr>
  <tr>
    <td style="padding:10px 40px 30px;">
      <p style="margin:0 0 34px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};">Yours sincerely,</p>
      <div style="width:180px;border-top:1px solid ${BRAND.ink};line-height:1px;font-size:0;margin-bottom:8px;">&nbsp;</div>
      <div style="font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};">${escapeHtml(letter.signatureName)}</div>
      ${letter.signatureTitle ? `<div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.body};">${escapeHtml(letter.signatureTitle)}</div>` : ''}
      <div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.muted};">For: ${escapeHtml(BRAND.name)}</div>
    </td>
  </tr>
  <tr>
    <td style="background:${BRAND.panel};border-top:1px solid ${BRAND.border};padding:22px 40px;border-radius:0 0 4px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:top;font-family:${font};font-size:12px;line-height:19px;color:${BRAND.muted};">
          <div style="font-weight:700;color:${BRAND.ink};font-size:13px;">${escapeHtml(BRAND.name)}</div>
          ${env.MAIL_COMPANY_ADDRESS ? `${escapeHtml(env.MAIL_COMPANY_ADDRESS)}<br>` : ''}
          ${contactLines.join(' &nbsp;·&nbsp; ')}
        </td>
        <td align="right" style="vertical-align:top;font-family:${font};font-size:12px;line-height:19px;white-space:nowrap;">
          <a href="${PLAY_STORE}" style="color:${BRAND.deep};text-decoration:none;font-weight:600;">Google Play</a><br>
          <a href="${APP_STORE}" style="color:${BRAND.deep};text-decoration:none;font-weight:600;">App Store</a>
        </td>
      </tr></table>
      <div style="border-top:1px solid ${BRAND.border};margin:16px 0 12px;line-height:1px;font-size:0;">&nbsp;</div>
      <div style="font-family:${font};font-size:11px;line-height:17px;color:${BRAND.muted};">
        This letter was sent to ${escapeHtml(to.email)} by ${escapeHtml(BRAND.name)}. It may contain confidential information intended only for the addressee; if you received it in error, please let us know at <a href="mailto:${escapeHtml(contactEmail)}" style="color:${BRAND.muted};">${escapeHtml(contactEmail)}</a> and delete it.<br>
        &copy; ${year} ${escapeHtml(BRAND.name)}. All rights reserved.
      </div>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const bodyText = sanitizeHtml(
    body
      .replace(/<\/(p|h[2-4]|li|blockquote|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• '),
    { allowedTags: [], allowedAttributes: {} },
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const text = [
    `${BRAND.name}`,
    `${website} · ${contactEmail}${env.MAIL_COMPANY_PHONE ? ` · ${env.MAIL_COMPANY_PHONE}` : ''}`,
    '',
    `Ref: ${letter.reference}`,
    formatDate(letter.date),
    '',
    ...(addressLines(to).length ? [...addressLines(to), ''] : []),
    `Dear ${greetingName || 'Sir/Madam'},`,
    '',
    letter.subject.toUpperCase(),
    '',
    bodyText,
    '',
    'Yours sincerely,',
    '',
    letter.signatureName,
    letter.signatureTitle ?? '',
    `For: ${BRAND.name}`,
    '',
    '—',
    `${BRAND.name}${env.MAIL_COMPANY_ADDRESS ? ` · ${env.MAIL_COMPANY_ADDRESS}` : ''}`,
    `This letter was sent to ${to.email}. © ${year} ${BRAND.name}. All rights reserved.`,
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');

  return { html, text };
}
