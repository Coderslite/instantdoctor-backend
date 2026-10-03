import type { UserRecord } from 'firebase-admin/auth';
import type * as s from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { newId } from '../../src/lib/ids.js';
import { bool, clock, int, num, plain, str, toDate, toGeo, validId } from './normalize.js';
import type { MigrationReport } from './report.js';
import type { SourceDoc } from './source.js';

type Insert<T extends { $inferInsert: unknown }> = T['$inferInsert'];

/** Lookup sets used to enforce referential integrity before inserting. */
export interface Refs {
  users: Set<string>;
  doctors: Set<string>;
  userIdByTag: Map<string, string>;
  appointments: Map<string, { userId: string; doctorId: string | null }>;
  packages: Map<string, { name: string; type: s.PackageType }>;
  healthTipCategories: Set<string>;
  healthTips: Set<string>;
  pharmacies: Set<string>;
  productCategories: Map<string, string>;
  products: Set<string>;
  reports: Set<string>;
}

export const emptyRefs = (): Refs => ({
  users: new Set(),
  doctors: new Set(),
  userIdByTag: new Map(),
  appointments: new Map(),
  packages: new Map(),
  healthTipCategories: new Set(),
  healthTips: new Set(),
  pharmacies: new Set(),
  productCategories: new Map(),
  products: new Set(),
  reports: new Set(),
});

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Some app versions saved the reverse-geocoded country *name* in the device
 * locale ("nigeria", "magyarország", "ελλάδα") instead of an ISO code. Pricing
 * keys on ISO codes, so names are resolved through ICU display names.
 */
const COUNTRY_LOCALES = ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'da', 'sv', 'no', 'fi', 'pl', 'hu', 'el', 'tr', 'ru', 'ar', 'zh', 'ja', 'ko'];
const countryByName = (() => {
  const map = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const fold = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  for (const locale of COUNTRY_LOCALES) {
    const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
    for (const a of letters) {
      for (const b of letters) {
        const name = names.of(a + b);
        // First match wins: canonical codes (GB) sort before reserved aliases (UK).
        if (name && !map.has(fold(name))) map.set(fold(name), a + b);
      }
    }
  }
  for (const [alias, code] of [['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['great britain', 'GB'], ['england', 'GB']] as const) {
    map.set(alias, code);
  }
  return (v: string) => map.get(fold(v));
})();

export function toIsoCountry(raw: string): string | null {
  const v = raw.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase() === 'UK' ? 'GB' : v.toUpperCase();
  return countryByName(v) ?? null;
}

// ─── Users ───────────────────────────────────────────────────────────────────

export interface UserBundle {
  users: Array<Insert<typeof s.users>>;
  medical: Array<Insert<typeof s.userMedicalProfiles>>;
  doctors: Array<Insert<typeof s.doctorProfiles>>;
  payouts: Array<Insert<typeof s.payoutAccounts>>;
  savedLocations: Array<Insert<typeof s.savedLocations>>;
}

const REMINDER_FIELDS = [
  'bookingReminderCountThisWeek',
  'bookingReminderCountToday',
  'doctorAvailabilityCountThisWeek',
  'eveningBookingCountThisWeek',
  'lastBookingReminderSentAt',
  'lastDoctorAvailabilitySentAt',
  'lastEveningBookingSentAt',
  'lastHealthTipSentAt',
];

export async function transformUsers(
  docs: SourceDoc[],
  authUsers: Map<string, UserRecord>,
  refs: Refs,
  report: MigrationReport,
): Promise<UserBundle> {
  const out: UserBundle = { users: [], medical: [], doctors: [], payouts: [], savedLocations: [] };
  const seenEmails = new Set<string>();
  const seenTags = new Set<string>();

  for (const { id, data: d } of docs) {
    if (!validId(id)) {
      report.skip('users', id, 'invalid id');
      continue;
    }
    const email = lower(d.email) || lower(authUsers.get(id)?.email);
    if (!email) {
      report.skip('users', id, 'no email');
      continue;
    }
    if (seenEmails.has(email)) {
      report.skip('users', id, `duplicate email ${email}`);
      continue;
    }
    seenEmails.add(email);

    let tag = str(d.tag, 64);
    if (tag && seenTags.has(tag.toLowerCase())) {
      report.warn('users', id, `duplicate tag "${tag}" cleared`);
      tag = null;
    }
    if (tag) seenTags.add(tag.toLowerCase());

    const role = lower(d.role) === 'doctor' ? 'doctor' : 'user';
    const plainPassword = typeof d.password === 'string' && d.password.length > 0 ? d.password : null;
    const geo = toGeo(d.location);
    const rawCountry = str(d.country, 64);
    const country = rawCountry ? toIsoCountry(rawCountry) : null;
    if (rawCountry && !country) report.warn('users', id, `unrecognised country "${rawCountry}" dropped`);
    const currency = str(d.currency);
    if (currency && currency.length !== 3) report.warn('users', id, `invalid currency "${currency}" dropped`);
    const auth = authUsers.get(id);

    const reminderState = Object.fromEntries(
      REMINDER_FIELDS.filter((k) => d[k] !== undefined).map((k) => [k, plain(d[k])]),
    );

    out.users.push({
      id,
      email,
      passwordHash: plainPassword ? await hashPassword(plainPassword) : null,
      legacyAuth: true,
      role,
      firstName: str(d.firstname, 100) ?? '',
      lastName: str(d.lastname, 100) ?? '',
      phoneNumber: str(d.phoneNumber, 32),
      photoUrl: str(d.photoUrl, 1024),
      gender: str(d.gender, 32),
      dateOfBirth: toDate(d.dob),
      maritalStatus: str(d.maritalStatus, 32),
      stateOfOrigin: str(d.stateOfOrigin, 64),
      otherLanguage: str(d.otherLanguage, 255),
      country,
      currency: currency && currency.length === 3 ? currency.toUpperCase() : null,
      platform: str(d.platform, 16),
      address: str(d.address, 512),
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      tag,
      presence: str(d.status, 16) ?? 'offline',
      lastSeenAt: toDate(d.lastSeen),
      fcmToken: str(d.token, 512),
      accountStatus: str(d.accountStatus, 32),
      isTrialAvailable: bool(d.isTrialAvailable, true),
      hasPaid: bool(d.isPaid),
      walletBalance: num(d.amount) ?? 0,
      referralBalance: num(d.referralBalance) ?? 0,
      referralEnabled: bool(d.referralEnabled),
      referralProgramApplied: bool(d.referralProgramApplied),
      referralProgramAppliedAt: toDate(d.referralProgramAppliedAt ?? d.referralAppliedAt),
      reminderState: Object.keys(reminderState).length ? reminderState : null,
      emailVerifiedAt: auth?.emailVerified ? (toDate(auth.metadata.creationTime) ?? new Date()) : null,
      createdAt: toDate(d.createdAt) ?? toDate(auth?.metadata.creationTime) ?? new Date(),
    });
    refs.users.add(id);
    if (role === 'doctor') refs.doctors.add(id);
    if (tag) refs.userIdByTag.set(tag.toLowerCase(), id);

    out.medical.push({
      userId: id,
      height: str(d.height, 16),
      weight: str(d.weight, 16),
      bloodGroup: str(d.bloodGroup, 8),
      genotype: str(d.genotype, 8),
      surgicalHistory: str(d.surgicalHistory),
    });

    if (role === 'doctor') {
      out.doctors.push({
        userId: id,
        specialization: str(d.specialization, 128),
        experienceYears: int(d.experience),
        bio: str(d.bio),
        isAvailable: bool(d.isAvailable),
        workingHours: Array.isArray(d.workingHour) ? (plain(d.workingHour) as unknown[]) : [],
        certificateUrl: str(d.certificate, 1024),
        institution: str(d.institution, 255),
        graduationYear: str(d.graduation, 8),
        housemanship: str(d.housemanship, 255),
        housemanshipYear: str(d.yearHousemanship, 8),
        workAddress: str(d.workAddress, 512),
        homeAddress: str(d.homeAddress, 512),
        registeredOn: str(d.registrationDate, 16),
      });
    }

    if (d.bankName || d.accountNumber) {
      out.payouts.push({
        userId: id,
        bankName: str(d.bankName, 128),
        accountNumber: str(d.accountNumber, 32),
        accountName: str(d.accountName, 255),
      });
    }

    if (Array.isArray(d.savedLocations)) {
      const seen = new Set<string>();
      for (const loc of d.savedLocations as Array<Record<string, unknown>>) {
        const lat = num(loc.latitude);
        const lng = num(loc.longitude);
        if (lat === null || lng === null) continue;
        let locId = validId(loc.id) ? loc.id : newId();
        if (seen.has(locId)) locId = newId();
        seen.add(locId);
        out.savedLocations.push({
          id: locId,
          userId: id,
          name: str(loc.name, 128) ?? 'Saved place',
          address: str(loc.address, 512) ?? '',
          latitude: lat,
          longitude: lng,
        });
      }
    }
  }
  return out;
}

/** Google/Apple identities from Firebase Auth provider data. */
export function transformAuthIdentities(authUsers: UserRecord[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.authIdentities>> = [];
  for (const u of authUsers) {
    if (!refs.users.has(u.uid)) {
      report.warn('auth_identities', u.uid, 'Firebase Auth user has no Firestore profile');
      continue;
    }
    for (const p of u.providerData) {
      const provider = p.providerId === 'google.com' ? 'google' : p.providerId === 'apple.com' ? 'apple' : null;
      if (!provider) continue;
      rows.push({ id: `${provider}:${p.uid}`.slice(0, 36), userId: u.uid, provider, providerUserId: p.uid });
    }
  }
  return rows;
}

export async function transformAdmins(docs: SourceDoc[], report: MigrationReport) {
  const rows: Array<Insert<typeof s.admins>> = [];
  for (const { id, data: d } of docs) {
    const email = lower(d.email);
    if (!email) {
      report.skip('admins', id, 'no email');
      continue;
    }
    let passwordHash: string | null = null;
    if (typeof d.password === 'string' && d.password) passwordHash = await hashPassword(d.password);
    else if (d.passwordHash) report.warn('admins', id, 'custom hash format cannot be converted; admin must reset password');
    rows.push({
      id,
      name: str(d.name, 128) ?? email,
      email,
      passwordHash,
      role: lower(d.role) === 'marketer' ? 'marketer' : 'admin',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

// ─── Platform config ─────────────────────────────────────────────────────────

export function transformSettings(settings: SourceDoc[], appConfig: SourceDoc[]) {
  const rows: Array<Insert<typeof s.appSettings>> = [];
  if (settings[0]) rows.push({ key: 'app', value: plain(settings[0].data) as object });
  if (appConfig[0]) rows.push({ key: 'product_prices', value: plain(appConfig[0].data) as object });
  return rows;
}

export function transformCurrencies(docs: SourceDoc[]) {
  const byCode = new Map<string, Insert<typeof s.currencies>>();
  for (const { id, data } of docs) {
    const code = str(data.symbol)?.toUpperCase();
    if (code?.length === 3 && !byCode.has(code)) byCode.set(code, { id, code });
  }
  return [...byCode.values()];
}

export function transformCharges(docs: SourceDoc[]) {
  return docs.map(({ id, data: d }) => ({
    id,
    type: str(d.type, 64) ?? id,
    name: str(d.name, 128) ?? 'Charge',
    amountUsd: num(d.dollarAmount) ?? 0,
    legacyPriceNgn: num(d.price),
  }));
}

export function transformZego(docs: SourceDoc[]) {
  return docs
    .filter(({ data }) => num(data.appId) && str(data.appSign))
    .map(({ id, data: d }) => ({ id, appId: num(d.appId)!, appSign: str(d.appSign)!, inUse: bool(d.inUse) }));
}

export function transformPackages(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.appointmentPackages>> = [];
  for (const { id, data: d } of docs) {
    const type = lower(d.type);
    if (type !== 'basic' && type !== 'standard' && type !== 'special') {
      report.skip('appointment_packages', id, `unknown package type "${d.type}"`);
      continue;
    }
    const name = str(d.name, 128) ?? type;
    rows.push({
      id,
      name,
      type,
      amountUsd: num(d.amount) ?? 0,
      listAmountUsd: num(d.dollarAmount),
      durationSeconds: int(d.duration) ?? 86_400,
      description: str(d.description),
    });
    refs.packages.set(id, { name, type });
  }
  return rows;
}

export function transformChargePackages(docs: SourceDoc[]) {
  return docs.map(({ id, parentId, data: d }) => ({
    id,
    currency: (parentId ?? '').toUpperCase().slice(0, 3),
    name: str(d.name, 128) ?? 'Package',
    amount: num(d.amount) ?? 0,
    durationSeconds: int(d.duration) ?? 0,
    description: str(d.description),
  }));
}

// ─── Appointments & chat ─────────────────────────────────────────────────────

const APPOINTMENT_STATUS: Record<string, s.AppointmentStatus> = {
  pending: 'pending',
  active: 'active',
  ongoing: 'active',
  accepted: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  deleted: 'deleted',
};

function resolvePackage(raw: string, refs: Refs) {
  const known = refs.packages.get(raw);
  if (known) return { packageId: raw, packageLabel: known.name, packageType: known.type };
  const l = raw.toLowerCase();
  const packageType: s.PackageType | null = l.includes('basic')
    ? 'basic'
    : l.includes('special') || l.includes('premium')
      ? 'special'
      : l.includes('standard')
        ? 'standard'
        : null;
  return { packageId: null, packageLabel: raw.slice(0, 128) || 'Consultation', packageType };
}

export function transformAppointments(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.appointments>> = [];
  for (const { id, data: d } of docs) {
    const userId = str(d.userId);
    const doctorId = str(d.doctorId);
    if (!userId || !refs.users.has(userId)) {
      report.skip('appointments', id, `patient ${userId} not found`);
      continue;
    }
    // An empty doctorId is an open request awaiting acceptance, not an orphan.
    if (doctorId && !refs.users.has(doctorId)) {
      report.skip('appointments', id, `doctor ${doctorId} not found`);
      continue;
    }
    const startTime = toDate(d.startTime);
    const endTime = toDate(d.endTime);
    if (!startTime || !endTime) {
      report.skip('appointments', id, 'missing start/end time');
      continue;
    }
    const status = APPOINTMENT_STATUS[lower(d.status)];
    if (!status) report.warn('appointments', id, `unknown status "${d.status}" -> pending`);
    const currency = str(d.currency);
    rows.push({
      id,
      userId,
      doctorId,
      complaint: str(d.complain ?? d.complaint),
      symptoms: Array.isArray(d.symptoms) ? d.symptoms.map(String) : [],
      status: status ?? 'pending',
      ...resolvePackage(str(d.package) ?? '', refs),
      startTime,
      endTime,
      price: num(d.price) ?? 0,
      currency: currency && currency.length === 3 ? currency.toUpperCase() : null,
      isTrial: bool(d.isTrial),
      isPaid: bool(d.isPaid),
      doctorEarning: num(d.doctorEarning),
      reminderCount: int(d.reminderCount) ?? 0,
      reminderCountToday: int(d.reminderCountToday) ?? 0,
      lastReminderSentAt: toDate(d.lastReminderSentAt),
      createdAt: toDate(d.createdAt) ?? startTime,
      updatedAt: toDate(d.updatedAt) ?? toDate(d.createdAt) ?? startTime,
    });
    refs.appointments.set(id, { userId, doctorId });
  }
  return rows;
}

const MESSAGE_TYPE: Record<string, (typeof s.MESSAGE_TYPES)[number]> = {
  text: 'text',
  image: 'image',
  file: 'file',
  voice: 'voice',
  audio: 'voice',
};
const MESSAGE_STATUS: Record<string, s.MessageStatus> = {
  pending: 'pending',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  deleted: 'deleted',
};

export function transformAppointmentMessages(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.appointmentMessages>> = [];
  for (const { id, parentId, data: d } of docs) {
    if (!parentId || !refs.appointments.has(parentId)) {
      report.skip('appointment_messages', id, `appointment ${parentId} not migrated`);
      continue;
    }
    const senderId = str(d.senderId);
    const receiverId = str(d.receiverId);
    if (!validId(senderId) || !validId(receiverId)) {
      report.skip('appointment_messages', id, 'invalid sender/receiver');
      continue;
    }
    rows.push({
      id,
      appointmentId: parentId,
      senderId,
      receiverId,
      type: MESSAGE_TYPE[lower(d.type)] ?? 'text',
      status: MESSAGE_STATUS[lower(d.status)] ?? 'delivered',
      message: typeof d.message === 'string' ? d.message : '',
      fileUrl: str(d.fileUrl, 1024),
      repliedToId: validId(d.repliedTo) ? d.repliedTo : null,
      repliedText: str(d.repliedText),
      repliedSenderId: validId(d.repliedSender) ? d.repliedSender : null,
      isEdited: bool(d.isEdited),
      editedAt: toDate(d.edited),
      isDeleted: bool(d.isDeleted),
      deletedAt: toDate(d.deleted),
      createdAt: toDate(d.createdAt) ?? new Date(0),
    });
  }
  return rows;
}

export function transformPrescriptions(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.prescriptions>> = [];
  for (const { id, data: d } of docs) {
    const appt = refs.appointments.get(str(d.appointmentId) ?? '');
    if (!appt) {
      report.skip('prescriptions', id, `appointment ${d.appointmentId} not migrated`);
      continue;
    }
    rows.push({
      id,
      appointmentId: d.appointmentId,
      userId: str(d.userId) ?? appt.userId,
      doctorId: str(d.doctorId) ?? appt.doctorId ?? '',
      prescription: str(d.prescription) ?? '',
      seen: bool(d.seen),
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformReviews(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.reviews>> = [];
  const seen = new Set<string>();
  for (const { id, data: d } of docs) {
    const appointmentId = str(d.appointmentId) ?? '';
    const userId = str(d.userId) ?? '';
    const doctorId = str(d.doctorId) ?? '';
    if (!refs.appointments.has(appointmentId) || !refs.users.has(userId) || !refs.users.has(doctorId)) {
      report.skip('reviews', id, 'appointment, patient or doctor not migrated');
      continue;
    }
    const key = `${appointmentId}:${userId}`;
    if (seen.has(key)) {
      report.skip('reviews', id, 'duplicate review for appointment');
      continue;
    }
    seen.add(key);
    const rating = Math.min(5, Math.max(1, int(d.rating) ?? 5));
    rows.push({ id, appointmentId, userId, doctorId, rating, review: str(d.review), createdAt: toDate(d.createdAt) ?? new Date() });
  }
  return rows;
}

const REPORT_STATUS: Record<string, (typeof s.REPORT_STATUSES)[number]> = {
  pending: 'pending',
  'in progress': 'in_progress',
  in_progress: 'in_progress',
  resolved: 'resolved',
  completed: 'resolved',
  closed: 'closed',
};

export function transformReports(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.reports>> = [];
  const perAppointment = new Set<string>();
  for (const { id, data: d } of docs) {
    const appt = refs.appointments.get(str(d.appointmentId) ?? '');
    if (!appt || perAppointment.has(d.appointmentId)) {
      report.skip('reports', id, appt ? 'duplicate report for appointment' : 'appointment not migrated');
      continue;
    }
    perAppointment.add(d.appointmentId);
    rows.push({
      id,
      appointmentId: d.appointmentId,
      userId: appt.userId,
      doctorId: appt.doctorId,
      subject: str(d.subject, 255) ?? 'Report',
      report: str(d.report) ?? '',
      status: REPORT_STATUS[lower(d.status)] ?? 'pending',
      createdAt: toDate(d.createdAt) ?? new Date(),
      updatedAt: toDate(d.updatedAt) ?? toDate(d.createdAt) ?? new Date(),
    });
    refs.reports.add(id);
  }
  return rows;
}

export function transformReportMessages(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.reportMessages>> = [];
  for (const { id, parentId, data: d } of docs) {
    if (!parentId || !refs.reports.has(parentId)) {
      report.skip('report_messages', id, 'report not migrated');
      continue;
    }
    rows.push({
      id,
      reportId: parentId,
      senderId: str(d.senderId, 36) ?? 'admin',
      receiverId: str(d.receiverId, 36) ?? 'admin',
      type: MESSAGE_TYPE[lower(d.type)] ?? 'text',
      status: MESSAGE_STATUS[lower(d.status)] ?? 'delivered',
      message: typeof d.message === 'string' ? d.message : '',
      fileUrl: str(d.fileUrl, 1024),
      createdAt: toDate(d.createdAt) ?? new Date(0),
    });
  }
  return rows;
}

// ─── Pharmacy ────────────────────────────────────────────────────────────────

export async function transformPharmacies(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.pharmacies>> = [];
  for (const { id, data: d } of docs) {
    const email = lower(d.email);
    if (!email) {
      report.skip('pharmacies', id, 'no email');
      continue;
    }
    const geo = toGeo(d.location);
    rows.push({
      id,
      name: str(d.name, 255) ?? 'Pharmacy',
      email,
      passwordHash: typeof d.password === 'string' && d.password ? await hashPassword(d.password) : null,
      phoneNumber: str(d.phoneNumber, 32),
      address: str(d.address, 512),
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      deliveryFeePerKm: num(d.deliveryFee) ?? 0,
      discount: int(d.discount) ?? 0,
      image: str(d.image, 1024),
      balance: num(d.balance) ?? 0,
      status: lower(d.status) || 'active',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
    refs.pharmacies.add(id);
  }
  return rows;
}

export function transformProductCategories(docs: SourceDoc[], refs: Refs) {
  return docs.map(({ id, data }) => {
    const name = str(data.name, 128) ?? id;
    refs.productCategories.set(name.toLowerCase(), id);
    refs.productCategories.set(id, id);
    return { id, name };
  });
}

export function transformProducts(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.products>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.pharmacies.has(str(d.pharmacyId) ?? '')) {
      report.skip('products', id, `pharmacy ${d.pharmacyId} not migrated`);
      continue;
    }
    const cat = str(d.category);
    rows.push({
      id,
      pharmacyId: d.pharmacyId,
      categoryId: cat ? (refs.productCategories.get(cat) ?? refs.productCategories.get(cat.toLowerCase()) ?? null) : null,
      name: str(d.name, 255) ?? 'Product',
      description: str(d.description),
      amount: num(d.amount) ?? 0,
      purchasePrice: num(d.purchasePrice),
      discount: int(d.discount) ?? 0,
      stockRemaining: int(d.remaining) ?? 0,
      images: Array.isArray(d.images) ? d.images.map(String) : [],
      status: lower(d.status) || 'active',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
    refs.products.add(id);
  }
  return rows;
}

const ORDER_STATUS: Record<string, s.OrderStatus> = {
  pending: 'pending',
  processing: 'processing',
  delivering: 'delivering',
  completed: 'completed',
  delivered: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

export function transformOrders(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const orders: Array<Insert<typeof s.orders>> = [];
  const items: Array<Insert<typeof s.orderItems>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '') || !refs.pharmacies.has(str(d.pharmacyId) ?? '')) {
      report.skip('orders', id, 'user or pharmacy not migrated');
      continue;
    }
    const lines = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
    const subtotal = lines.reduce((sum, l) => sum + (num(l.amount) ?? 0) * (int(l.quantity) ?? 1), 0);
    const deliveryFee = num(d.deliveryFee) ?? 0;
    orders.push({
      id,
      userId: d.userId,
      pharmacyId: d.pharmacyId,
      trackingId: str(d.trackingId, 16) ?? id.slice(0, 16),
      status: ORDER_STATUS[lower(d.status)] ?? 'pending',
      subtotal,
      deliveryFee,
      totalAmount: num(d.totalAmount) ?? subtotal + deliveryFee,
      pharmacyEarning: num(d.pharmacyEarning),
      address: str(d.address, 512),
      createdAt: toDate(d.createdAt) ?? new Date(),
      updatedAt: toDate(d.updatedAt) ?? toDate(d.createdAt) ?? new Date(),
    });
    for (const l of lines) {
      const productId = str(l.id);
      items.push({
        id: newId(),
        orderId: id,
        productId: productId && refs.products.has(productId) ? productId : null,
        name: str(l.name, 255) ?? 'Item',
        unitPrice: num(l.amount) ?? 0,
        discount: int(l.discount) ?? 0,
        quantity: int(l.quantity) ?? 1,
        image: Array.isArray(l.images) ? str(l.images[0], 1024) : null,
      });
    }
  }
  return { orders, items };
}

// ─── Health ──────────────────────────────────────────────────────────────────

export function transformLabResults(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const results: Array<Insert<typeof s.labResults>> = [];
  const files: Array<Insert<typeof s.labResultFiles>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('lab_results', id, `user ${d.userId} not migrated`);
      continue;
    }
    const status = lower(d.status) === 'completed' ? 'completed' : 'pending';
    results.push({
      id,
      userId: d.userId,
      status,
      resultUrl: str(d.resultUrl, 1024),
      opened: bool(d.opened),
      createdAt: toDate(d.createdAt) ?? new Date(),
      updatedAt: toDate(d.updatedAt ?? d.updateddAt) ?? toDate(d.createdAt) ?? new Date(),
    });
    const list = Array.isArray(d.files) ? (d.files as Array<Record<string, unknown>>) : [];
    if (d.fileUrl) list.push({ fileUrl: d.fileUrl, fileType: 'File' });
    for (const f of list) {
      const url = str(f.fileUrl, 1024);
      if (url) files.push({ id: newId(), labResultId: id, fileUrl: url, fileType: str(f.fileType, 32) ?? 'File' });
    }
  }
  return { results, files };
}

/**
 * Legacy `takenDates` are device-local midnights stored as UTC instants.
 * Shifting by +12h before taking the UTC date recovers the local calendar
 * day for every UTC-12..UTC+12 zone.
 */
const localDay = (d: Date) => new Date(d.getTime() + 12 * 3_600_000).toISOString().slice(0, 10);

export function transformMedications(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const meds: Array<Insert<typeof s.medications>> = [];
  const doses: Array<Insert<typeof s.medicationDoses>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('medications', id, `user ${d.userId} not migrated`);
      continue;
    }
    const start = toDate(d.startTime);
    const end = toDate(d.endTime);
    if (!start || !end) {
      report.skip('medications', id, 'missing start/end time');
      continue;
    }
    meds.push({
      id,
      userId: d.userId,
      name: str(d.name, 255) ?? 'Medication',
      prescription: str(d.prescription),
      startTime: start,
      endTime: end,
      morningTime: clock(d.morning),
      middayTime: clock(d.midDay),
      eveningTime: clock(d.evening),
      intervalHours: int(d.interval) ?? 0,
      createdAt: toDate(d.createdAt) ?? start,
    });

    const slots = new Map<string, Insert<typeof s.medicationDoses>>();
    const add = (date: string, time: string | null, status: 'taken' | 'missed') => {
      const key = `${date}|${time}`;
      // "taken" wins over "missed" for the same slot, mirroring the app UI.
      if (slots.get(key)?.status === 'taken') return;
      slots.set(key, { id: newId(), medicationId: id, doseDate: date, doseTime: time, status });
    };
    for (const [field, status] of [['dailyMissedTimes', 'missed'], ['dailyTakenTimes', 'taken']] as const) {
      const map = d[field];
      if (!map || typeof map !== 'object') continue;
      for (const [date, times] of Object.entries(map as Record<string, unknown[]>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(times)) continue;
        for (const t of times) {
          const time = clock(t);
          if (time) add(date, time, status);
        }
      }
    }
    // Days recorded without a dose time (older app versions).
    for (const [field, status] of [['missedDates', 'missed'], ['takenDates', 'taken']] as const) {
      if (!Array.isArray(d[field])) continue;
      for (const v of d[field] as unknown[]) {
        const date = toDate(v);
        if (!date) continue;
        const day = localDay(date);
        const hasTimed = [...slots.values()].some((x) => x.doseDate === day && x.status === status);
        if (!hasTimed) add(day, null, status);
      }
    }
    doses.push(...slots.values());
  }
  return { meds, doses };
}

// ─── Content & engagement ────────────────────────────────────────────────────

export function transformHealthTipCategories(docs: SourceDoc[], refs: Refs) {
  return docs.map(({ id, data }) => {
    refs.healthTipCategories.add(id);
    return { id, name: str(data.name, 128) ?? 'General', image: str(data.image, 1024) };
  });
}

export function transformHealthTips(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const seenSlugs = new Set<string>();
  return docs.map(({ id, data: d }) => {
    let categoryId = str(d.categoryId);
    if (categoryId && !refs.healthTipCategories.has(categoryId)) {
      report.warn('health_tips', id, `unknown category ${categoryId} cleared`);
      categoryId = null;
    }
    let slug = str(d.slug, 255);
    if (slug && seenSlugs.has(slug)) slug = null;
    if (slug) seenSlugs.add(slug);
    refs.healthTips.add(id);
    return {
      id,
      categoryId,
      title: str(d.title, 255) ?? 'Untitled',
      slug,
      description: typeof d.description === 'string' ? d.description : '',
      image: str(d.image, 1024),
      type: str(d.type, 32) ?? 'article',
      views: int(d.views) ?? 0,
      isSent: bool(d.isSent),
      publishedAt: toDate(d.publishedAt),
      createdAt: toDate(d.createdAt) ?? new Date(),
    };
  });
}

export function transformHealthTipInteractions(docs: SourceDoc[], refs: Refs, report: MigrationReport, entity: string) {
  const rows: Array<{ healthTipId: string; userId: string; createdAt: Date }> = [];
  for (const { id, parentId, data: d } of docs) {
    const userId = str(d.userId) ?? id;
    if (!parentId || !refs.healthTips.has(parentId) || !refs.users.has(userId)) {
      report.skip(entity, `${parentId}/${id}`, 'tip or user not migrated');
      continue;
    }
    rows.push({ healthTipId: parentId, userId, createdAt: toDate(d.createdAt) ?? new Date() });
  }
  return rows;
}

const NOTIFICATION_TYPE: Record<string, s.NotificationType> = {
  chat: 'chat',
  transaction: 'transaction',
  appointment: 'appointment',
  medication: 'medication',
  call: 'call',
  labresult: 'lab_result',
  lab_result: 'lab_result',
};

export function transformNotifications(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.notifications>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('notifications', id, `user ${d.userId} not migrated`);
      continue;
    }
    const type = NOTIFICATION_TYPE[lower(d.type)];
    if (!type) {
      report.skip('notifications', id, `unknown type "${d.type}"`);
      continue;
    }
    rows.push({
      id,
      userId: d.userId,
      type,
      title: str(d.title, 512) ?? '',
      uniqueId: str(d.uniqueId, 128),
      status: lower(d.status) === 'read' ? 'read' : 'delivered',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformAnonymous(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.anonymousQuestions>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('anonymous_questions', id, `user ${d.userId} not migrated`);
      continue;
    }
    rows.push({
      id,
      userId: d.userId,
      question: str(d.question) ?? '',
      answer: str(d.answer),
      status: lower(d.status) === 'completed' ? 'completed' : 'pending',
      createdAt: toDate(d.createdAt) ?? new Date(),
      updatedAt: toDate(d.updatedAt) ?? toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformReferrals(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.referrals>> = [];
  const seenUsers = new Set<string>();
  for (const { id, data: d } of docs) {
    const userId = str(d.userId) ?? '';
    if (!refs.users.has(userId)) {
      report.skip('referrals', id, `referred user ${userId} not migrated`);
      continue;
    }
    if (seenUsers.has(userId)) {
      report.skip('referrals', id, 'user already has a referral record');
      continue;
    }
    seenUsers.add(userId);
    const tag = (str(d.referredBy, 64) ?? '').toLowerCase();
    const referrerId = refs.userIdByTag.get(tag) ?? null;
    if (!referrerId) report.warn('referrals', id, `referrer tag "${tag}" does not match any user`);
    rows.push({
      id,
      userId,
      referrerTag: tag,
      referrerId: referrerId === userId ? null : referrerId,
      status: lower(d.status) === 'inactive' ? 'inactive' : 'active',
      signupBonusPaid: bool(d.signupBonusPaid),
      totalCommissionEarned: num(d.totalCommissionEarned) ?? 0,
      lastCommissionAt: toDate(d.lastCommissionDate),
      createdAt: toDate(d.createdAt) ?? new Date(),
      updatedAt: toDate(d.updatedAt) ?? toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformTransactions(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.walletTransactions>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('wallet_transactions', id, `user ${d.userId} not migrated`);
      continue;
    }
    rows.push({
      id,
      userId: d.userId,
      type: lower(d.transactionType) === 'credit' ? 'credit' : 'debit',
      amount: num(d.amount) ?? 0,
      currency: 'NGN',
      title: str(d.title, 255) ?? 'Transaction',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformWithdrawals(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.withdrawals>> = [];
  for (const { id, data: d } of docs) {
    if (!refs.users.has(str(d.userId) ?? '')) {
      report.skip('withdrawals', id, `user ${d.userId} not migrated`);
      continue;
    }
    rows.push({
      id,
      userId: d.userId,
      type: str(d.type, 32) ?? 'user',
      amount: num(d.amount) ?? 0,
      bankName: str(d.bankName, 128),
      bankCode: str(d.bankCode, 32),
      accountNumber: str(d.accountNumber, 32),
      accountName: str(d.accountName, 255),
      recipientCode: str(d.recipientCode, 64),
      status: lower(d.status) || 'pending',
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}

export function transformWaitlist(docs: SourceDoc[], refs: Refs, report: MigrationReport) {
  const rows: Array<Insert<typeof s.waitlistEntries>> = [];
  for (const { id, data: d } of docs) {
    const geo = toGeo(d.location);
    if (!refs.users.has(str(d.userId) ?? '') || !geo) {
      report.skip('waitlist_entries', id, 'user not migrated or no location');
      continue;
    }
    rows.push({
      id,
      userId: d.userId,
      address: str(d.address, 512) ?? '',
      latitude: geo.latitude,
      longitude: geo.longitude,
      createdAt: toDate(d.createdAt) ?? new Date(),
    });
  }
  return rows;
}
