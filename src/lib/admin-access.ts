import type { AdminRole } from '../db/schema/users.js';

/**
 * Role-based access for the admin. The admin is split into areas; each role
 * can view or manage an area. Every /admin request is matched to an area by
 * its path (reads need view, anything else needs manage), and a path no rule
 * covers is for full admins only, so a new endpoint is closed until it is
 * placed in an area here.
 */

export const ADMIN_AREAS = [
  'overview',
  'appointments',
  'patients',
  'doctors',
  'pharmacy',
  'lab_results',
  'hmos',
  'finance',
  'blog',
  'mail',
  'notifications',
  'settings',
  'team',
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];
export type AreaAccess = 'view' | 'manage';
export type AdminPermissions = Partial<Record<AdminArea, AreaAccess>>;

export const ROLE_INFO: Record<AdminRole, { label: string; description: string }> = {
  admin: { label: 'Admin', description: 'Everything, including the team, prices and fees.' },
  operations: {
    label: 'Operations',
    description: 'Runs the service day to day: appointments, patients, doctors, pharmacies, lab results and HMOs. Can see finance, not change it.',
  },
  finance: {
    label: 'Finance',
    description: 'Payments, revenue, doctor and pharmacy payouts, HMO claims and invoices. Can see appointments, patients and orders to reconcile.',
  },
  clinical: {
    label: 'Clinical',
    description: 'Doctors and their applications, lab result reviews and the appointment review queue. Can see patient records.',
  },
  support: {
    label: 'Support',
    description: 'Helps patients: patient accounts, appointments and notifications. Can see orders, lab results, doctors and HMOs.',
  },
  marketer: {
    label: 'Marketing',
    description: 'Blog, mail and push notifications. Sees names and emails to choose recipients, never medical records or finance.',
  },
};

const all = (access: AreaAccess) => Object.fromEntries(ADMIN_AREAS.map((a) => [a, access])) as AdminPermissions;

export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermissions> = {
  admin: all('manage'),
  operations: {
    overview: 'view',
    appointments: 'manage',
    patients: 'manage',
    doctors: 'manage',
    pharmacy: 'manage',
    lab_results: 'manage',
    hmos: 'manage',
    notifications: 'manage',
    finance: 'view',
  },
  finance: {
    overview: 'view',
    finance: 'manage',
    hmos: 'manage',
    appointments: 'view',
    patients: 'view',
    doctors: 'view',
    pharmacy: 'view',
    settings: 'view',
  },
  clinical: {
    overview: 'view',
    doctors: 'manage',
    lab_results: 'manage',
    appointments: 'manage',
    patients: 'view',
  },
  support: {
    overview: 'view',
    patients: 'manage',
    appointments: 'manage',
    notifications: 'manage',
    pharmacy: 'view',
    lab_results: 'view',
    doctors: 'view',
    hmos: 'view',
  },
  marketer: {
    overview: 'view',
    blog: 'manage',
    mail: 'manage',
    notifications: 'manage',
  },
};

export const permissionsFor = (role: AdminRole): AdminPermissions => ROLE_PERMISSIONS[role] ?? {};

export const can = (role: AdminRole, area: AdminArea, access: AreaAccess = 'view') => {
  const granted = permissionsFor(role)[area];
  return granted === 'manage' || (access === 'view' && granted === 'view');
};

type Rule = {
  /** Path inside /admin, e.g. /patients/123. */
  path: RegExp;
  /** Only these methods; any when omitted. */
  methods?: string[];
  /** Any one of these grants the request. */
  areas: AdminArea[];
  /** The access needed; by default reads need view and writes need manage. */
  access?: AreaAccess;
};

const GET = ['GET', 'HEAD'];

/** First match wins, so specific paths come before the area they sit inside. */
const RULES: Rule[] = [
  // Everyone signed in: their own account and uploads for the forms they can use.
  { path: /^\/me(\/|$)/, areas: [...ADMIN_AREAS], access: 'view' },
  { path: /^\/uploads(\/|$)/, areas: ['blog', 'lab_results', 'pharmacy', 'doctors', 'mail', 'patients'] },
  { path: /^\/dashboard$/, areas: ['overview'] },

  // Choosing recipients for mail and push: names and emails, not records.
  { path: /^\/(patients|doctors)$/, methods: GET, areas: ['patients', 'doctors', 'mail', 'notifications'], access: 'view' },
  { path: /^\/patients\/[^/]+\/push$/, areas: ['notifications'] },

  // Money inside other areas.
  { path: /^\/(doctors|pharmacies)\/[^/]+\/ledger(-adjustments)?$/, areas: ['finance'] },
  { path: /^\/(payments|payouts|doctor-payouts|revenue)(\/|$)/, areas: ['finance'] },
  { path: /^\/commercial-fees$/, methods: GET, areas: ['finance', 'settings'] },
  { path: /^\/commercial-fees$/, areas: ['settings'] },
  { path: /^\/appointment-packages(\/|$)/, methods: GET, areas: ['appointments', 'settings'] },
  { path: /^\/appointment-packages(\/|$)/, areas: ['settings'] },

  { path: /^\/appointments(\/|$)/, areas: ['appointments'] },
  { path: /^\/(patients|family-care)(\/|$)/, areas: ['patients'] },
  // Suspending or reactivating any account (patient or doctor).
  { path: /^\/users\/[^/]+\/status$/, areas: ['patients', 'doctors'] },
  { path: /^\/(doctors|doctor-applications)(\/|$)/, areas: ['doctors'] },
  { path: /^\/(pharmacies|products|product-categories|orders|pharmacy-applications)(\/|$)/, areas: ['pharmacy'] },
  { path: /^\/lab-results(\/|$)/, areas: ['lab_results'] },
  { path: /^\/(hmos|hmo-link-requests|hmo-applications)(\/|$)/, areas: ['hmos'] },
  { path: /^\/blog(\/|$)/, areas: ['blog'] },
  { path: /^\/mail(\/|$)/, areas: ['mail'] },
  { path: /^\/team(\/|$)/, areas: ['team'] },
];

/** Whether this role may make this request (path relative to /admin). */
export function allows(role: AdminRole, method: string, path: string): boolean {
  if (role === 'admin') return true;
  const verb = method.toUpperCase();
  const rule = RULES.find((r) => r.path.test(path) && (!r.methods || r.methods.includes(verb)));
  if (!rule) return false;
  const needed = rule.access ?? (GET.includes(verb) ? 'view' : 'manage');
  return rule.areas.some((area) => can(role, area, needed));
}
