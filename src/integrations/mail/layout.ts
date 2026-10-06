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

export interface LayoutOptions {
  preheader: string;
  body: string;
  footerNote?: string;
}

export function layout({ preheader, body, footerNote }: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(BRAND.name)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.canvas};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.canvas};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 20px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;"><img src="${escapeHtml(env.MAIL_LOGO_URL)}" width="34" height="36" alt="" style="display:block;border:0;"></td>
                <td style="vertical-align:middle;padding-left:10px;font-family:${BRAND.font};font-size:18px;font-weight:700;color:${BRAND.ink};letter-spacing:-0.2px;">${escapeHtml(BRAND.name)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;">
            <div style="height:4px;background:${BRAND.primary};line-height:4px;font-size:0;">&nbsp;</div>
            <div style="padding:32px 32px 28px;">${body}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 8px 0;font-family:${BRAND.font};font-size:12px;line-height:19px;color:${BRAND.muted};text-align:center;">
            ${footerNote ? `${footerNote}<br><br>` : ''}
            Need help? Reply to this email or contact <a href="mailto:${escapeHtml(env.MAIL_REPLY_TO)}" style="color:${BRAND.deep};text-decoration:none;">${escapeHtml(env.MAIL_REPLY_TO)}</a><br>
            <a href="${escapeHtml(env.WEBSITE_URL)}" style="color:${BRAND.muted};text-decoration:none;">${escapeHtml(BRAND.name)}</a> &middot; Quality healthcare, wherever you are
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export function plainText(lines: Array<string | null | undefined | false>): string {
  return [
    ...lines.filter((line): line is string => typeof line === 'string'),
    '',
    '—',
    `${BRAND.name} · ${env.WEBSITE_URL}`,
    `Need help? Contact ${env.MAIL_REPLY_TO}`,
  ].join('\n');
}
