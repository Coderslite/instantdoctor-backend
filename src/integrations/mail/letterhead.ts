import sanitizeHtml from 'sanitize-html';
import { env } from '../../config/env.js';
import { BRAND, brandedDocument, contactLinks, escapeHtml } from './layout.js';
export { APP_STORE, PLAY_STORE } from './layout.js';

/**
 * Official correspondence from the admin Mail centre: letterhead with logo and
 * contact details, reference and date, subject line, salutation, body,
 * signature block and a company footer. Tables and inline styles only, so it
 * renders the same in Gmail, Outlook and Apple Mail.
 */

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
  /** letter (default): ref, date, salutation, signature. email: just the body between the logo header and footer. */
  style?: 'letter' | 'email';
}

/** {{firstName}}, {{name}} and {{email}} in the body become the recipient's details. */
const PLACEHOLDER = /\{\{\s*(firstName|name|email|organization)\s*\}\}/gi;

function placeholderValues(to: LetterRecipient): Record<string, string> {
  const firstName = to.firstName?.trim() || to.name?.trim().split(/\s+/)[0] || '';
  return {
    organization: to.organization?.trim() ?? '',
    firstname: firstName,
    name: to.name?.trim() || firstName,
    email: to.email,
  };
}

/** {{firstName}}, {{name}}, {{email}} and {{organization}} in the body become the recipient's details. */
function personalise(html: string, to: LetterRecipient) {
  const values = placeholderValues(to);
  return html.replace(PLACEHOLDER, (_m, key: string) =>
    escapeHtml(values[key.toLowerCase()] ?? ''),
  );
}

/** The subject with the recipient's details filled in (plain text, for the email header and the letter). */
export function personaliseSubject(subject: string, to: LetterRecipient) {
  const values = placeholderValues(to);
  return subject
    .replace(PLACEHOLDER, (_m, key: string) => values[key.toLowerCase()] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
  const subject = personaliseSubject(letter.subject, to);
  const contactLines = contactLinks(contactEmail);
  const year = letter.date.getFullYear();
  const isEmail = letter.style === 'email';
  const kind = isEmail ? 'email' : 'letter';

  const html = brandedDocument({
    title: subject,
    preheader: `${subject} — ${BRAND.name}`,
    // A letterhead carries the contact details; an email has them in the footer only.
    headerAside: isEmail ? undefined : contactLines.join('<br>'),
    contactEmail,
    year,
    smallPrint: `This ${kind} was sent to ${escapeHtml(to.email)} by ${escapeHtml(BRAND.name)}. It may contain confidential information intended only for the addressee; if you received it in error, please let us know at <a href="mailto:${escapeHtml(contactEmail)}" style="color:${BRAND.muted};">${escapeHtml(contactEmail)}</a> and delete it.`,
    rows: `
  ${isEmail ? '' : `<tr>
    <td style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${font};font-size:12px;color:${BRAND.muted};">Ref: <span style="color:${BRAND.ink};font-weight:600;">${escapeHtml(letter.reference)}</span></td>
        <td align="right" style="font-family:${font};font-size:12px;color:${BRAND.muted};">${escapeHtml(formatDate(letter.date))}</td>
      </tr></table>
    </td>
  </tr>`}
  <tr>
    <td style="padding:${isEmail ? '28px' : '24px'} 40px 8px;">
      ${isEmail ? body : `${addressLines(to).length ? `<p style="margin:0 0 22px;font-family:${font};font-size:14px;line-height:21px;color:${BRAND.ink};">${addressLines(to).map(escapeHtml).join('<br>')}</p>` : ''}
      <p style="margin:0 0 18px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};">Dear ${escapeHtml(greetingName || 'Sir/Madam')},</p>
      <p style="margin:0 0 18px;font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};text-decoration:underline;text-underline-offset:3px;">${escapeHtml(subject.toUpperCase())}</p>
      ${body}`}
    </td>
  </tr>
  ${isEmail ? (letter.signatureName ? `<tr>
    <td style="padding:4px 40px 30px;">
      <div style="font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};">${escapeHtml(letter.signatureName)}</div>
      ${letter.signatureTitle ? `<div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.body};">${escapeHtml(letter.signatureTitle)}</div>` : ''}
      <div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.muted};">${escapeHtml(BRAND.name)}</div>
    </td>
  </tr>` : '<tr><td style="padding:0 0 22px;line-height:1px;font-size:0;">&nbsp;</td></tr>') : `<tr>
    <td style="padding:10px 40px 30px;">
      <p style="margin:0 0 34px;font-family:${font};font-size:15px;line-height:24px;color:${BRAND.body};">Yours sincerely,</p>
      <div style="width:180px;border-top:1px solid ${BRAND.ink};line-height:1px;font-size:0;margin-bottom:8px;">&nbsp;</div>
      <div style="font-family:${font};font-size:15px;line-height:22px;font-weight:700;color:${BRAND.ink};">${escapeHtml(letter.signatureName)}</div>
      ${letter.signatureTitle ? `<div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.body};">${escapeHtml(letter.signatureTitle)}</div>` : ''}
      <div style="font-family:${font};font-size:13px;line-height:20px;color:${BRAND.muted};">For: ${escapeHtml(BRAND.name)}</div>
    </td>
  </tr>`}
`,
  });

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
  const footerText = [
    '—',
    `${BRAND.name}${env.MAIL_COMPANY_ADDRESS ? ` · ${env.MAIL_COMPANY_ADDRESS}` : ''}`,
    `${website} · ${contactEmail}${env.MAIL_COMPANY_PHONE ? ` · ${env.MAIL_COMPANY_PHONE}` : ''}`,
    `This ${kind} was sent to ${to.email}. © ${year} ${BRAND.name}. All rights reserved.`,
  ];
  if (isEmail)
    return {
      html,
      text: [
        bodyText,
        '',
        ...(letter.signatureName ? [letter.signatureName, letter.signatureTitle ?? '', BRAND.name, ''] : []),
        ...footerText,
      ]
        .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
        .join('\n'),
    };
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
    subject.toUpperCase(),
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
