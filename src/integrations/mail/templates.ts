import { env } from '../../config/env.js';
import {
  BRAND,
  button,
  codeBox,
  detailsTable,
  escapeHtml,
  heading,
  layout,
  muted,
  notice,
  paragraph,
  plainText,
} from './layout.js';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export type CodePurpose = 'register' | 'password_reset' | 'login';

const greeting = (firstName?: string | null) => (firstName?.trim() ? `Hi ${firstName.trim()},` : 'Hi there,');

const formatTime = (date: Date) =>
  `${date.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;

const CODE_COPY: Record<CodePurpose, { noun: string; intro: string; action: string }> = {
  register: {
    noun: 'verification code',
    intro: 'Thanks for signing up for Instant Doctor. Use the code below to verify your email address and finish creating your account.',
    action: 'verify your email',
  },
  password_reset: {
    noun: 'password reset code',
    intro: 'We received a request to reset the password for your Instant Doctor account. Use the code below to continue.',
    action: 'reset your password',
  },
  login: {
    noun: 'sign-in code',
    intro: 'Use the code below to sign in to your Instant Doctor account.',
    action: 'sign in',
  },
};

export function verificationCode(input: {
  code: string;
  purpose: CodePurpose;
  firstName?: string | null;
  expiresInMinutes: number;
}): RenderedMail {
  const copy = CODE_COPY[input.purpose];
  const subject = `${input.code} is your ${BRAND.name} ${copy.noun}`;
  const html = layout({
    preheader: `Your ${copy.noun} is ${input.code}. It expires in ${input.expiresInMinutes} minutes.`,
    body: [
      heading(`Your ${copy.noun}`),
      paragraph(escapeHtml(greeting(input.firstName))),
      paragraph(escapeHtml(copy.intro)),
      paragraph(`Your ${escapeHtml(copy.noun)} is <strong>${escapeHtml(input.code)}</strong>`),
      codeBox(input.code),
      paragraph(
        `This code expires in <strong>${input.expiresInMinutes} minutes</strong> and can only be used once.`,
      ),
      notice(
        `<strong>Keep this code private.</strong> ${escapeHtml(BRAND.name)} will never ask you for it by phone, email or chat. If you didn't try to ${escapeHtml(copy.action)}, you can safely ignore this email.`,
        'warning',
      ),
    ].join(''),
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    copy.intro,
    '',
    `Your ${copy.noun} is ${input.code}`,
    '',
    `This code expires in ${input.expiresInMinutes} minutes and can only be used once.`,
    `Keep it private: ${BRAND.name} will never ask you for it. If you didn't try to ${copy.action}, you can ignore this email.`,
  ]);
  return { subject, html, text };
}

export function welcome(input: { firstName?: string | null }): RenderedMail {
  const features: Array<[string, string]> = [
    ['Consult a doctor', 'Book a video, voice or chat consultation with a licensed doctor in minutes.'],
    ['Order medication', 'Get prescriptions and pharmacy essentials delivered to your door.'],
    ['Understand your lab results', 'Upload results and have a doctor explain them in plain language.'],
    ['Never miss a dose', 'Set medication reminders and track your treatment.'],
  ];
  const html = layout({
    preheader: 'Your account is ready. Here is how Instant Doctor can help you stay well.',
    body: [
      heading(`Welcome to ${BRAND.name}`),
      paragraph(escapeHtml(greeting(input.firstName))),
      paragraph(
        'Your account is ready. You now have a doctor in your pocket, whenever you need one. Here is what you can do:',
      ),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">${features
        .map(
          ([title, description]) => `
        <tr>
          <td style="padding:0 0 14px;vertical-align:top;width:28px;">
            <div style="width:20px;height:20px;border-radius:10px;background:#E0F5FD;text-align:center;font-family:${BRAND.font};font-size:12px;line-height:20px;font-weight:700;color:${BRAND.deep};">&#10003;</div>
          </td>
          <td style="padding:0 0 14px;font-family:${BRAND.font};font-size:14px;line-height:21px;color:${BRAND.body};">
            <strong style="color:${BRAND.ink};">${escapeHtml(title)}</strong><br>${escapeHtml(description)}
          </td>
        </tr>`,
        )
        .join('')}</table>`,
      button('Open Instant Doctor', env.WEBSITE_URL),
      muted('Your health information is private and only shared with the doctors you consult.'),
    ].join(''),
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    `Welcome to ${BRAND.name}. Your account is ready. Here is what you can do:`,
    ...features.map(([title, description]) => `• ${title}: ${description}`),
    '',
    `Open Instant Doctor: ${env.WEBSITE_URL}`,
  ]);
  return { subject: `Welcome to ${BRAND.name}`, html, text };
}

export function signInAlert(input: {
  firstName?: string | null;
  device: string;
  ipAddress?: string | null;
  at: Date;
}): RenderedMail {
  const rows: Array<[string, string]> = [
    ['Device', input.device],
    ['Time', formatTime(input.at)],
    ...(input.ipAddress ? ([['IP address', input.ipAddress]] as Array<[string, string]>) : []),
  ];
  const html = layout({
    preheader: `New sign-in on ${input.device}. If this was you, no action is needed.`,
    body: [
      heading('New sign-in to your account'),
      paragraph(escapeHtml(greeting(input.firstName))),
      paragraph('Your Instant Doctor account was just signed in to:'),
      detailsTable(rows),
      paragraph('If this was you, there is nothing else you need to do.'),
      notice(
        "<strong>Don't recognise this sign-in?</strong> Reset your password from the app straight away using <em>Forgot password</em>. This signs you out of every device.",
        'warning',
      ),
    ].join(''),
    footerNote: 'You are receiving this security alert because of a sign-in to your account.',
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    'Your Instant Doctor account was just signed in to:',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    "If this was you, there's nothing else to do. If not, reset your password from the app straight away using Forgot password.",
  ]);
  return { subject: `New sign-in to your ${BRAND.name} account`, html, text };
}

export function passwordChanged(input: { firstName?: string | null; at: Date }): RenderedMail {
  const html = layout({
    preheader: 'Your password was changed and you were signed out of all devices.',
    body: [
      heading('Your password was changed'),
      paragraph(escapeHtml(greeting(input.firstName))),
      paragraph(
        `The password for your Instant Doctor account was changed on <strong>${escapeHtml(formatTime(input.at))}</strong>. For your security, you've been signed out of all devices.`,
      ),
      notice(
        "<strong>Didn't change your password?</strong> Reset it now from the app using <em>Forgot password</em>, and contact our support team so we can secure your account.",
        'warning',
      ),
    ].join(''),
    footerNote: 'You are receiving this security notice because your account password changed.',
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    `The password for your Instant Doctor account was changed on ${formatTime(input.at)}. You've been signed out of all devices.`,
    '',
    "Didn't change your password? Reset it now from the app using Forgot password and contact our support team.",
  ]);
  return { subject: `Your ${BRAND.name} password was changed`, html, text };
}

export interface OrderLine {
  name: string;
  quantity: number;
}

export function pharmacyNewOrder(input: {
  pharmacyName?: string | null;
  trackingId: string;
  customerName: string;
  items: OrderLine[];
  deliveryAddress?: string | null;
}): RenderedMail {
  const itemRows = input.items
    .map(
      (item, i) => `
    <tr>
      <td style="padding:11px 16px;${i ? `border-top:1px solid ${BRAND.border};` : ''}font-family:${BRAND.font};font-size:14px;color:${BRAND.ink};">${escapeHtml(item.name)}</td>
      <td align="right" style="padding:11px 16px;${i ? `border-top:1px solid ${BRAND.border};` : ''}font-family:${BRAND.font};font-size:14px;font-weight:600;color:${BRAND.ink};white-space:nowrap;">&times; ${escapeHtml(item.quantity)}</td>
    </tr>`,
    )
    .join('');
  const html = layout({
    preheader: `New paid order ${input.trackingId} from ${input.customerName}.`,
    body: [
      heading('You have a new order'),
      paragraph(escapeHtml(input.pharmacyName?.trim() ? `Hello ${input.pharmacyName.trim()},` : 'Hello,')),
      paragraph('A customer has placed and paid for an order. Please prepare it for delivery.'),
      detailsTable([
        ['Order', input.trackingId],
        ['Customer', input.customerName],
        ...(input.deliveryAddress ? ([['Deliver to', input.deliveryAddress]] as Array<[string, string]>) : []),
      ]),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border:1px solid ${BRAND.border};border-radius:12px;border-collapse:separate;">
        <tr><td colspan="2" style="padding:11px 16px;background:${BRAND.panel};border-radius:12px 12px 0 0;font-family:${BRAND.font};font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${BRAND.muted};">Items</td></tr>
        ${itemRows}
      </table>`,
      muted('Update the order status from your pharmacy dashboard as you process it.'),
    ].join(''),
  });
  const text = plainText([
    input.pharmacyName?.trim() ? `Hello ${input.pharmacyName.trim()},` : 'Hello,',
    '',
    'A customer has placed and paid for an order. Please prepare it for delivery.',
    `Order: ${input.trackingId}`,
    `Customer: ${input.customerName}`,
    input.deliveryAddress ? `Deliver to: ${input.deliveryAddress}` : null,
    '',
    'Items:',
    ...input.items.map((item) => `• ${item.name} × ${item.quantity}`),
  ]);
  return { subject: `New order ${input.trackingId} – ${BRAND.name}`, html, text };
}

const ORDER_STATUS_COPY: Record<string, { label: string; message: string }> = {
  pending: { label: 'Order received', message: 'We have received your order and sent it to the pharmacy.' },
  processing: { label: 'Being prepared', message: 'The pharmacy is preparing your order.' },
  delivering: { label: 'Out for delivery', message: 'Your order is on its way to you.' },
  completed: { label: 'Delivered', message: 'Your order has been delivered. We hope you feel better soon.' },
  cancelled: { label: 'Cancelled', message: 'Your order was cancelled. Contact support if you have any questions.' },
};

export function orderStatusUpdate(input: {
  firstName?: string | null;
  trackingId: string;
  status: string;
  items: OrderLine[];
  total: string;
}): RenderedMail {
  const copy = ORDER_STATUS_COPY[input.status] ?? { label: input.status, message: 'Your order status has changed.' };
  const html = layout({
    preheader: `${copy.label}: order ${input.trackingId}. ${copy.message}`,
    body: [
      heading(copy.label),
      paragraph(escapeHtml(greeting(input.firstName))),
      paragraph(escapeHtml(copy.message)),
      detailsTable([
        ['Order', input.trackingId],
        ['Status', copy.label],
        ['Items', input.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')],
        ['Total', input.total],
      ]),
      muted('You can follow your order any time from the Orders tab in the app.'),
    ].join(''),
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    copy.message,
    `Order: ${input.trackingId}`,
    `Status: ${copy.label}`,
    `Items: ${input.items.map((item) => `${item.name} × ${item.quantity}`).join(', ')}`,
    `Total: ${input.total}`,
  ]);
  return { subject: `${copy.label} – order ${input.trackingId}`, html, text };
}

export function opsActivity(input: {
  activity: string;
  user: { id: string; name: string; email: string; phoneNumber?: string | null; country?: string | null };
  at: Date;
}): RenderedMail {
  const rows: Array<[string, string]> = [
    ['Activity', input.activity],
    ['Customer', input.user.name || '—'],
    ['Email', input.user.email],
    ['Phone', input.user.phoneNumber || '—'],
    ['Country', input.user.country || '—'],
    ['User ID', input.user.id],
    ['Time', formatTime(input.at)],
  ];
  const html = layout({
    preheader: `${input.activity} by ${input.user.name || input.user.email}`,
    body: [
      heading(`New activity: ${input.activity}`),
      paragraph('A customer just completed an action in the app.'),
      detailsTable(rows),
    ].join(''),
    footerNote: 'Internal notification for the Instant Doctor operations team.',
  });
  const text = plainText([
    `New activity: ${input.activity}`,
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ]);
  return { subject: `[Activity] ${input.activity} – ${input.user.name || input.user.email}`, html, text };
}

export type AppointmentEvent = 'confirmed' | 'accepted' | 'completed' | 'cancelled';

export interface AppointmentEmailInput {
  event: AppointmentEvent;
  firstName?: string | null;
  doctorName?: string | null;
  packageName: string;
  isTrial: boolean;
  start: Date;
  end: Date;
  timeZone?: string | null;
  amount?: string | null;
}

function zoned(date: Date, timeZone: string | null | undefined, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timeZone || 'UTC' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(date);
  }
}

export function appointmentSchedule(start: Date, end: Date, timeZone?: string | null) {
  const date = zoned(start, timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDate = zoned(start, timeZone, { weekday: 'short', day: 'numeric', month: 'short' });
  const from = zoned(start, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  const to = zoned(end, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  return { date, shortDate, from, time: `${from} – ${to}` };
}

export function appointmentUpdate(input: AppointmentEmailInput): RenderedMail {
  const when = appointmentSchedule(input.start, input.end, input.timeZone);
  const doctor = input.doctorName?.trim() || null;
  const copy: Record<AppointmentEvent, { subject: string; title: string; lines: string[]; notice?: string }> = {
    confirmed: {
      subject: `Appointment confirmed – ${when.shortDate}, ${when.from}`,
      title: 'Your appointment is confirmed',
      lines: doctor
        ? [`Your consultation with ${doctor} is booked. We'll remind you before it starts.`]
        : [
            "Your consultation is booked and we're matching you with an available doctor.",
            "You'll get an email as soon as a doctor accepts your appointment.",
          ],
    },
    accepted: {
      subject: `${doctor ?? 'A doctor'} accepted your appointment`,
      title: `${doctor ?? 'Your doctor'} has accepted your appointment`,
      lines: [
        'Your doctor is ready for your consultation.',
        'At the scheduled time, open the app to chat with or call your doctor.',
      ],
    },
    completed: {
      subject: `Your consultation${doctor ? ` with ${doctor}` : ''} is complete`,
      title: 'Your consultation is complete',
      lines: [
        "Thank you for consulting with Instant Doctor. If your doctor added a prescription, you'll find it in the appointment in the app.",
        "We'd love to hear how it went. Rate your doctor in the app to help us keep care quality high.",
      ],
    },
    cancelled: {
      subject: `Your appointment on ${when.shortDate} was cancelled`,
      title: 'Your appointment was cancelled',
      lines: [`${doctor ?? 'Your doctor'} cancelled this appointment.`],
      notice: "<strong>Need to rebook?</strong> Reply to this email or contact our support team and we'll help you find another time.",
    },
  };
  const c = copy[input.event];
  const rows: Array<[string, string]> = [
    ['Doctor', doctor ?? 'Being assigned'],
    ['Date', when.date],
    ['Time', when.time],
    ['Consultation', input.isTrial ? `${input.packageName} (free trial)` : input.packageName],
    ...(input.amount && input.event === 'confirmed' ? ([['Amount paid', input.amount]] as Array<[string, string]>) : []),
  ];
  const html = layout({
    preheader: `${c.title}. ${when.date}, ${when.time}.`,
    body: [
      heading(c.title),
      paragraph(escapeHtml(greeting(input.firstName))),
      ...c.lines.map((line) => paragraph(escapeHtml(line))),
      detailsTable(rows),
      c.notice ? notice(c.notice, 'warning') : '',
      muted('Manage your appointments from the Appointments tab in the Instant Doctor app.'),
    ].join(''),
  });
  const text = plainText([
    greeting(input.firstName),
    '',
    ...c.lines,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    c.notice ? '' : null,
    c.notice ? "Need to rebook? Reply to this email or contact our support team and we'll help you find another time." : null,
  ]);
  return { subject: c.subject, html, text };
}
