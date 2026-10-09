import {
  and,
  count,
  desc,
  eq,
  gte,
  like,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { resolveFileUrl, withResolvedUrls } from '../files/files.service.js';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from '../../db/client.js';
import {
  admins,
  appSettings,
  appointmentPackages,
  appointments,
  doctorProfiles,
  labResultFiles,
  labResults,
  orders,
  payments,
  payoutAccounts,
  pharmacies,
  productCategories,
  products,
  userMedicalProfiles,
  users,
} from '../../db/schema/index.js';
import { isListedCurrency } from '../settings/settings.service.js';
import { usdRate } from '../../integrations/exchange-rates.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { signAdminAccessToken } from '../../lib/tokens.js';
import {
  closeAllPortalSessions,
  closePortalSession,
  openPortalSession,
  rotatePortalSession,
} from '../auth/portal-sessions.js';
import { newId } from '../../lib/ids.js';
import { deliver } from '../../integrations/mail/transport.js';
import { escapeHtml, layout, paragraph, plainText } from '../../integrations/mail/layout.js';
import { sendPush } from '../../integrations/push.js';
import { createNotification } from '../notifications/notifications.service.js';
import { COMMERCIAL_FEES_SETTINGS_KEY, getFeePolicy, type FeePolicy } from '../pricing/fees.js';

type ListQuery = { search?: string; status?: string; limit: number; offset: number };
const patient = alias(users, 'patient');
const doctor = alias(users, 'doctor');
const fullName = (first: SQLWrapper, last: SQLWrapper) =>
  sql<string>`concat(${first}, ' ', ${last})`;
const searchTerm = (value?: string) => (value ? `%${value}%` : undefined);

export const getCommercialFees = () => getFeePolicy();

export async function updateCommercialFees(fees: FeePolicy) {
  await db
    .insert(appSettings)
    .values({ key: COMMERCIAL_FEES_SETTINGS_KEY, value: fees })
    .onDuplicateKeyUpdate({ set: { value: fees } });
  return { fees: await getFeePolicy() };
}

const adminSession = (
  admin: Pick<typeof admins.$inferSelect, 'id' | 'role'>,
  refreshToken: string,
) => ({
  accessToken: signAdminAccessToken({ sub: admin.id, role: admin.role }),
  refreshToken,
  tokenType: 'Bearer' as const,
});

export async function login(email: string, password: string, userAgent?: string) {
  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.email, email.toLowerCase()))
    .limit(1);
  if (!admin?.passwordHash || !(await verifyPassword(password, admin.passwordHash)))
    throw unauthorized('Invalid email or password');
  return {
    admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    session: adminSession(admin, await openPortalSession('admin', admin.id, userAgent)),
  };
}

export async function refreshSession(refreshToken: string, userAgent?: string) {
  const rotated = await rotatePortalSession('admin', refreshToken, userAgent);
  const [admin] = await db
    .select({ id: admins.id, role: admins.role })
    .from(admins)
    .where(eq(admins.id, rotated.subjectId))
    .limit(1);
  if (!admin) {
    await closeAllPortalSessions('admin', rotated.subjectId);
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  return { session: adminSession(admin, rotated.refreshToken) };
}

export const logout = (refreshToken: string) => closePortalSession('admin', refreshToken);

export async function dashboard() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const nextMonth = new Date(monthStart);
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const [
    [patientCount],
    [doctorCount],
    [appointmentCount],
    [pendingCount],
    [activeCount],
    [completedCount],
    [cancelledCount],
    [revenue],
    [appointmentEarnings],
    monthlyAppointments,
  ] = await Promise.all([
    db.select({ value: count() }).from(users).where(eq(users.role, 'user')),
    db.select({ value: count() }).from(users).where(eq(users.role, 'doctor')),
    db.select({ value: count() }).from(appointments),
    db.select({ value: count() }).from(appointments).where(eq(appointments.status, 'pending')),
    db.select({ value: count() }).from(appointments).where(eq(appointments.status, 'active')),
    db.select({ value: count() }).from(appointments).where(eq(appointments.status, 'completed')),
    db.select({ value: count() }).from(appointments).where(eq(appointments.status, 'cancelled')),
    db
      .select({ value: sql<number>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(eq(payments.status, 'succeeded')),
    db
      .select({
        doctorEscrow: sql<number>`coalesce(sum(case when ${appointments.isTrial} then 0 else coalesce(${appointments.doctorEarning}, ${appointments.price} * 0.6) end), 0)`,
        platformEarnings: sql<number>`coalesce(sum(${appointments.price} - case when ${appointments.isTrial} then 0 else coalesce(${appointments.doctorEarning}, ${appointments.price} * 0.6) end), 0)`,
      })
      .from(appointments)
      .where(eq(appointments.isPaid, true)),
    db
      .select({
        date: sql<string>`date_format(${appointments.startTime}, '%Y-%m-%d')`,
        value: count(),
      })
      .from(appointments)
      .where(and(gte(appointments.startTime, monthStart), lt(appointments.startTime, nextMonth)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);
  return {
    patients: patientCount?.value ?? 0,
    doctors: doctorCount?.value ?? 0,
    appointments: appointmentCount?.value ?? 0,
    pendingAppointments: pendingCount?.value ?? 0,
    activeAppointments: activeCount?.value ?? 0,
    completedAppointments: completedCount?.value ?? 0,
    cancelledAppointments: cancelledCount?.value ?? 0,
    monthlyAppointments,
    revenue: revenue?.value ?? 0,
    platformEarnings: appointmentEarnings?.platformEarnings ?? 0,
    doctorEscrow: appointmentEarnings?.doctorEscrow ?? 0,
  };
}

export async function listUsers(role: 'user' | 'doctor', query: ListQuery) {
  const term = searchTerm(query.search);
  const filters: SQL[] = [eq(users.role, role)];
  if (query.status) filters.push(eq(users.accountStatus, query.status));
  if (term)
    filters.push(
      or(
        like(users.firstName, term),
        like(users.lastName, term),
        like(users.email, term),
        like(users.phoneNumber, term),
      )!,
    );
  const where = and(...filters);
  const items = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phoneNumber: users.phoneNumber,
      photoUrl: users.photoUrl,
      role: users.role,
      accountStatus: users.accountStatus,
      presence: users.presence,
      lastSeenAt: users.lastSeenAt,
      walletBalance: users.walletBalance,
      createdAt: users.createdAt,
      appointmentCount: sql<number>`(
        select count(*) from ${appointments}
        where ${appointments.userId} = ${users.id}
      )`,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.lastSeenAt), desc(users.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db.select({ value: count() }).from(users).where(where);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function getPatient(id: string) {
  const [patientRecord] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phoneNumber: users.phoneNumber,
      photoUrl: users.photoUrl,
      gender: users.gender,
      dateOfBirth: users.dateOfBirth,
      maritalStatus: users.maritalStatus,
      country: users.country,
      address: users.address,
      currency: users.currency,
      accountStatus: users.accountStatus,
      presence: users.presence,
      lastSeenAt: users.lastSeenAt,
      walletBalance: users.walletBalance,
      referralBalance: users.referralBalance,
      referralEnabled: users.referralEnabled,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      hasPushToken: sql<boolean>`${users.fcmToken} is not null and ${users.fcmToken} <> ''`,
      height: userMedicalProfiles.height,
      weight: userMedicalProfiles.weight,
      bloodGroup: userMedicalProfiles.bloodGroup,
      genotype: userMedicalProfiles.genotype,
      surgicalHistory: userMedicalProfiles.surgicalHistory,
    })
    .from(users)
    .leftJoin(userMedicalProfiles, eq(userMedicalProfiles.userId, users.id))
    .where(and(eq(users.id, id), eq(users.role, 'user')))
    .limit(1);
  if (!patientRecord) throw notFound('Patient');
  const [[appointmentTotal], [labResultTotal], recentAppointments] = await Promise.all([
    db.select({ value: count() }).from(appointments).where(eq(appointments.userId, id)),
    db.select({ value: count() }).from(labResults).where(eq(labResults.userId, id)),
    db
      .select({
        id: appointments.id,
        packageLabel: appointments.packageLabel,
        complaint: appointments.complaint,
        symptoms: appointments.symptoms,
        status: appointments.status,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        doctorName: fullName(doctor.firstName, doctor.lastName),
        price: appointments.price,
        currency: appointments.currency,
        isPaid: appointments.isPaid,
      })
      .from(appointments)
      .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
      .where(eq(appointments.userId, id))
      .orderBy(desc(appointments.startTime))
      .limit(100),
  ]);
  return {
    ...patientRecord,
    appointmentCount: appointmentTotal?.value ?? 0,
    labResultCount: labResultTotal?.value ?? 0,
    recentAppointments,
  };
}

type PatientUpdate = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string | null;
  gender?: string | null;
  dateOfBirth?: Date | null;
  maritalStatus?: string | null;
  country?: string | null;
  address?: string | null;
  currency?: string | null;
  height?: string | null;
  weight?: string | null;
  bloodGroup?: string | null;
  genotype?: string | null;
  surgicalHistory?: string | null;
};
export async function updatePatient(id: string, input: PatientUpdate) {
  const [patientRecord] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, 'user')))
    .limit(1);
  if (!patientRecord) throw notFound('Patient');
  const { height, weight, bloodGroup, genotype, surgicalHistory, ...userInput } = input;
  const medicalInput = { height, weight, bloodGroup, genotype, surgicalHistory };
  await db.transaction(async (tx) => {
    if (Object.values(userInput).some((value) => value !== undefined))
      await tx.update(users).set(userInput).where(eq(users.id, id));
    if (Object.values(medicalInput).some((value) => value !== undefined))
      await tx
        .insert(userMedicalProfiles)
        .values({ userId: id, ...medicalInput })
        .onDuplicateKeyUpdate({ set: medicalInput });
  });
  return getPatient(id);
}

export async function emailPatient(id: string, subject: string, message: string) {
  const [patientRecord] = await db
    .select({ email: users.email, firstName: users.firstName })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, 'user')))
    .limit(1);
  if (!patientRecord) throw notFound('Patient');
  await deliver({
    to: patientRecord.email,
    subject,
    category: 'admin-patient-message',
    html: layout({
      preheader: subject,
      body:
        paragraph(`Hello ${escapeHtml(patientRecord.firstName)},`) +
        paragraph(escapeHtml(message).replace(/\n/g, '<br>')),
    }),
    text: plainText([`Hello ${patientRecord.firstName},`, '', message]),
  });
  return { delivered: true };
}

export async function pushPatient(id: string, title: string, message: string) {
  const [patientRecord] = await db
    .select({ id: users.id, token: users.fcmToken })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, 'user')))
    .limit(1);
  if (!patientRecord) throw notFound('Patient');
  if (!patientRecord.token?.trim()) throw badRequest('This patient has no registered device');
  const emit = await createNotification({
    userId: patientRecord.id,
    type: 'chat',
    title: `${title} — ${message}`,
  });
  emit();
  await sendPush([patientRecord.token], { title, body: message, data: { type: 'admin_message' } });
  return { delivered: Boolean(patientRecord.token), stored: true };
}

export async function listDoctors(query: ListQuery) {
  const term = searchTerm(query.search);
  const filters: SQL[] = [eq(users.role, 'doctor')];
  if (term)
    filters.push(
      or(
        like(users.firstName, term),
        like(users.lastName, term),
        like(users.email, term),
        like(doctorProfiles.specialization, term),
      )!,
    );
  const where = and(...filters);
  const items = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phoneNumber: users.phoneNumber,
      accountStatus: users.accountStatus,
      presence: users.presence,
      specialization: doctorProfiles.specialization,
      experienceYears: doctorProfiles.experienceYears,
      isAvailable: doctorProfiles.isAvailable,
      certificateUrl: doctorProfiles.certificateUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db.select({ value: count() }).from(users).where(eq(users.role, 'doctor'));
  return {
    items: await withResolvedUrls(items, 'certificateUrl'),
    total: total?.value ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getDoctor(id: string) {
  const [doctorRecord] = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      phoneNumber: users.phoneNumber,
      photoUrl: users.photoUrl,
      gender: users.gender,
      country: users.country,
      address: users.address,
      currency: users.currency,
      earningCurrency: users.earningCurrency,
      accountStatus: users.accountStatus,
      presence: users.presence,
      lastSeenAt: users.lastSeenAt,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      specialization: doctorProfiles.specialization,
      experienceYears: doctorProfiles.experienceYears,
      bio: doctorProfiles.bio,
      isAvailable: doctorProfiles.isAvailable,
      workingHours: doctorProfiles.workingHours,
      certificateUrl: doctorProfiles.certificateUrl,
      institution: doctorProfiles.institution,
      graduationYear: doctorProfiles.graduationYear,
      housemanship: doctorProfiles.housemanship,
      housemanshipYear: doctorProfiles.housemanshipYear,
      workAddress: doctorProfiles.workAddress,
      homeAddress: doctorProfiles.homeAddress,
      registeredOn: doctorProfiles.registeredOn,
      bankName: payoutAccounts.bankName,
      accountNumber: payoutAccounts.accountNumber,
      accountName: payoutAccounts.accountName,
    })
    .from(users)
    .leftJoin(doctorProfiles, eq(doctorProfiles.userId, users.id))
    .leftJoin(payoutAccounts, eq(payoutAccounts.userId, users.id))
    .where(and(eq(users.id, id), eq(users.role, 'doctor')))
    .limit(1);
  if (!doctorRecord) throw notFound('Doctor');
  const [[appointmentTotal], [completedTotal], [earnings], recentAppointments] = await Promise.all([
    db.select({ value: count() }).from(appointments).where(eq(appointments.doctorId, id)),
    db
      .select({ value: count() })
      .from(appointments)
      .where(and(eq(appointments.doctorId, id), eq(appointments.status, 'completed'))),
    db
      .select({ value: sql<number>`coalesce(sum(${appointments.doctorEarning}), 0)` })
      .from(appointments)
      .where(and(eq(appointments.doctorId, id), eq(appointments.isPaid, true))),
    db
      .select({
        id: appointments.id,
        patientName: fullName(patient.firstName, patient.lastName),
        packageLabel: appointments.packageLabel,
        status: appointments.status,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        price: appointments.price,
        currency: appointments.currency,
        isPaid: appointments.isPaid,
        doctorEarning: appointments.doctorEarning,
      })
      .from(appointments)
      .innerJoin(patient, eq(patient.id, appointments.userId))
      .where(eq(appointments.doctorId, id))
      .orderBy(desc(appointments.startTime))
      .limit(100),
  ]);
  return {
    ...doctorRecord,
    certificateUrl: await resolveFileUrl(doctorRecord.certificateUrl),
    appointmentCount: appointmentTotal?.value ?? 0,
    completedAppointmentCount: completedTotal?.value ?? 0,
    totalEarnings: earnings?.value ?? 0,
    recentAppointments,
  };
}

type DoctorUpdate = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string | null;
  gender?: string | null;
  country?: string | null;
  address?: string | null;
  currency?: string | null;
  earningCurrency?: string;
  specialization?: string | null;
  experienceYears?: number | null;
  bio?: string | null;
  isAvailable?: boolean;
  institution?: string | null;
  graduationYear?: string | null;
  housemanship?: string | null;
  housemanshipYear?: string | null;
  workAddress?: string | null;
  homeAddress?: string | null;
  certificateUrl?: string | null;
};
export async function updateDoctor(id: string, input: DoctorUpdate) {
  const [doctorRecord] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, 'doctor')))
    .limit(1);
  if (!doctorRecord) throw notFound('Doctor');
  const {
    specialization,
    experienceYears,
    bio,
    isAvailable,
    institution,
    graduationYear,
    housemanship,
    housemanshipYear,
    workAddress,
    homeAddress,
    certificateUrl,
    earningCurrency,
    ...userInput
  } = input;
  const profileInput = {
    specialization,
    experienceYears,
    bio,
    isAvailable,
    institution,
    graduationYear,
    housemanship,
    housemanshipYear,
    workAddress,
    homeAddress,
    certificateUrl,
  };
  if (earningCurrency !== undefined) {
    if (!(await isListedCurrency(earningCurrency))) {
      throw badRequest('Choose a supported earning currency', [
        { path: 'earningCurrency', message: 'unsupported' },
      ]);
    }
    await usdRate(earningCurrency);
  }
  await db.transaction(async (tx) => {
    const userPatch = {
      ...userInput,
      ...(earningCurrency !== undefined && { earningCurrency }),
    };
    if (Object.values(userPatch).some((value) => value !== undefined))
      await tx.update(users).set(userPatch).where(eq(users.id, id));
    if (Object.values(profileInput).some((value) => value !== undefined))
      await tx
        .insert(doctorProfiles)
        .values({ userId: id, ...profileInput })
        .onDuplicateKeyUpdate({ set: profileInput });
  });
  return getDoctor(id);
}

export async function setUserStatus(id: string, status: 'active' | 'suspended') {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (!user) throw notFound('User');
  await db.update(users).set({ accountStatus: status }).where(eq(users.id, id));
  return { id, accountStatus: status };
}

export async function listAppointments(query: ListQuery) {
  const term = searchTerm(query.search);
  const filters: SQL[] = [];
  if (query.status)
    filters.push(
      eq(appointments.status, query.status as (typeof appointments.status.enumValues)[number]),
    );
  if (term)
    filters.push(
      or(
        like(appointments.complaint, term),
        like(patient.firstName, term),
        like(patient.lastName, term),
        like(doctor.firstName, term),
        like(doctor.lastName, term),
      )!,
    );
  const where = filters.length ? and(...filters) : undefined;
  const items = await db
    .select({
      id: appointments.id,
      patientId: appointments.userId,
      patientName: fullName(patient.firstName, patient.lastName),
      doctorId: appointments.doctorId,
      doctorName: fullName(doctor.firstName, doctor.lastName),
      complaint: appointments.complaint,
      status: appointments.status,
      packageLabel: appointments.packageLabel,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      price: appointments.price,
      currency: appointments.currency,
      isPaid: appointments.isPaid,
      createdAt: appointments.createdAt,
    })
    .from(appointments)
    .innerJoin(patient, eq(patient.id, appointments.userId))
    .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
    .where(where)
    .orderBy(desc(appointments.startTime))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db
    .select({ value: count() })
    .from(appointments)
    .where(
      query.status
        ? eq(appointments.status, query.status as (typeof appointments.status.enumValues)[number])
        : undefined,
    );
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function setAppointmentStatus(
  id: string,
  status: (typeof appointments.status.enumValues)[number],
) {
  const [item] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);
  if (!item) throw notFound('Appointment');
  await db.update(appointments).set({ status }).where(eq(appointments.id, id));
  return { id, status };
}

export async function getAppointment(id: string) {
  const [item] = await db
    .select({
      id: appointments.id,
      patientId: appointments.userId,
      patientName: fullName(patient.firstName, patient.lastName),
      patientEmail: patient.email,
      patientPhone: patient.phoneNumber,
      doctorId: appointments.doctorId,
      doctorName: fullName(doctor.firstName, doctor.lastName),
      complaint: appointments.complaint,
      symptoms: appointments.symptoms,
      status: appointments.status,
      packageId: appointments.packageId,
      packageLabel: appointments.packageLabel,
      packageType: appointments.packageType,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      timeZone: appointments.timeZone,
      price: appointments.price,
      currency: appointments.currency,
      isTrial: appointments.isTrial,
      isPaid: appointments.isPaid,
      paidAt: appointments.paidAt,
      doctorEarning: appointments.doctorEarning,
      createdAt: appointments.createdAt,
      updatedAt: appointments.updatedAt,
    })
    .from(appointments)
    .innerJoin(patient, eq(patient.id, appointments.userId))
    .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
    .where(eq(appointments.id, id))
    .limit(1);
  if (!item) throw notFound('Appointment');
  const paymentItems = await db
    .select({
      id: payments.id,
      reference: payments.reference,
      provider: payments.provider,
      method: payments.method,
      status: payments.status,
      baseAmount: payments.baseAmount,
      surcharge: payments.surcharge,
      amount: payments.amount,
      currency: payments.currency,
      failureReason: payments.failureReason,
      customerConfirmedAt: payments.customerConfirmedAt,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.purpose, 'appointment'), eq(payments.purposeRefId, id)))
    .orderBy(desc(payments.createdAt));
  return { ...item, payments: paymentItems };
}

type AppointmentUpdate = {
  doctorId?: string | null;
  status?: (typeof appointments.status.enumValues)[number];
  complaint?: string | null;
  packageLabel?: string;
  startTime?: Date;
  endTime?: Date;
  price?: number;
  currency?: string | null;
  isPaid?: boolean;
};
export async function updateAppointment(id: string, input: AppointmentUpdate) {
  const current = await getAppointment(id);
  if (input.doctorId) {
    const [assignedDoctor] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!assignedDoctor) throw notFound('Doctor');
  }
  const startTime = input.startTime ?? current.startTime;
  const endTime = input.endTime ?? current.endTime;
  if (endTime <= startTime) throw badRequest('Appointment end time must be after start time');
  await db
    .update(appointments)
    .set({
      ...input,
      ...(input.isPaid === true
        ? { paidAt: new Date() }
        : input.isPaid === false
          ? { paidAt: null }
          : {}),
    })
    .where(eq(appointments.id, id));
  return getAppointment(id);
}

type AppointmentCreate = {
  patientId: string;
  doctorId?: string | null;
  complaint?: string | null;
  symptoms: string[];
  status: (typeof appointments.status.enumValues)[number];
  packageLabel: string;
  packageType?: (typeof appointments.packageType.enumValues)[number] | null;
  startTime: Date;
  endTime: Date;
  timeZone?: string | null;
  price: number;
  currency: string;
  isTrial: boolean;
  isPaid: boolean;
};
export async function createAppointment(input: AppointmentCreate) {
  if (input.endTime <= input.startTime)
    throw badRequest('Appointment end time must be after start time');
  const [patientRecord] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.patientId), eq(users.role, 'user')))
    .limit(1);
  if (!patientRecord) throw notFound('Patient');
  if (input.doctorId) {
    const [doctorRecord] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.doctorId), eq(users.role, 'doctor')))
      .limit(1);
    if (!doctorRecord) throw notFound('Doctor');
  }
  const id = newId();
  await db.insert(appointments).values({
    id,
    userId: input.patientId,
    doctorId: input.doctorId ?? null,
    complaint: input.complaint ?? null,
    symptoms: input.symptoms,
    status: input.status,
    packageLabel: input.packageLabel,
    packageType: input.packageType ?? null,
    startTime: input.startTime,
    endTime: input.endTime,
    timeZone: input.timeZone ?? null,
    price: input.price,
    currency: input.currency,
    isTrial: input.isTrial,
    isPaid: input.isPaid,
    paidAt: input.isPaid ? new Date() : null,
  });
  return getAppointment(id);
}

export async function listAppointmentPackages() {
  return db
    .select()
    .from(appointmentPackages)
    .orderBy(appointmentPackages.sortOrder, appointmentPackages.amountUsd);
}

type AppointmentPackageInput = {
  name: string;
  type: (typeof appointmentPackages.type.enumValues)[number];
  amountUsd: number;
  listAmountUsd?: number | null;
  durationMinutes: number;
  description?: string | null;
  features: (typeof appointmentPackages.$inferInsert)['features'];
  sortOrder: number;
  isRecommended: boolean;
  badge?: string | null;
  isActive: boolean;
};
export async function createAppointmentPackage(input: AppointmentPackageInput) {
  const id = newId();
  await db.insert(appointmentPackages).values({
    id,
    name: input.name,
    type: input.type,
    amountUsd: input.amountUsd,
    listAmountUsd: input.listAmountUsd ?? null,
    durationSeconds: input.durationMinutes * 60,
    description: input.description ?? null,
    features: input.features,
    sortOrder: input.sortOrder,
    isRecommended: input.isRecommended,
    badge: input.badge ?? null,
    isActive: input.isActive,
  });
  const [item] = await db.select().from(appointmentPackages).where(eq(appointmentPackages.id, id));
  return item;
}

export async function updateAppointmentPackage(
  id: string,
  input: Partial<AppointmentPackageInput>,
) {
  const [item] = await db
    .select({ id: appointmentPackages.id })
    .from(appointmentPackages)
    .where(eq(appointmentPackages.id, id))
    .limit(1);
  if (!item) throw notFound('Appointment package');
  const { durationMinutes, ...rest } = input;
  await db
    .update(appointmentPackages)
    .set({
      ...rest,
      ...(durationMinutes === undefined ? {} : { durationSeconds: durationMinutes * 60 }),
    })
    .where(eq(appointmentPackages.id, id));
  const [updated] = await db
    .select()
    .from(appointmentPackages)
    .where(eq(appointmentPackages.id, id));
  return updated;
}

export async function listPharmacies(query: ListQuery) {
  const term = searchTerm(query.search);
  const where = and(
    query.status ? eq(pharmacies.status, query.status) : undefined,
    term
      ? or(
          like(pharmacies.name, term),
          like(pharmacies.email, term),
          like(pharmacies.phoneNumber, term),
        )
      : undefined,
  );
  const items = await db
    .select()
    .from(pharmacies)
    .where(where)
    .orderBy(desc(pharmacies.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db.select({ value: count() }).from(pharmacies).where(where);
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

type PharmacyInput = {
  name: string;
  email: string;
  password?: string;
  phoneNumber?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  deliveryFeePerKm?: number;
  discount?: number;
  image?: string | null;
  status?: string;
};
export async function createPharmacy(input: PharmacyInput) {
  const id = newId();
  const { password, ...values } = input;
  await db.insert(pharmacies).values({
    id,
    ...values,
    email: values.email.toLowerCase(),
    passwordHash: password ? await hashPassword(password) : null,
  });
  return getAdminPharmacy(id);
}
export async function updatePharmacy(id: string, input: Partial<PharmacyInput>) {
  const [item] = await db
    .select({ id: pharmacies.id })
    .from(pharmacies)
    .where(eq(pharmacies.id, id))
    .limit(1);
  if (!item) throw notFound('Pharmacy');
  const { password, ...values } = input;
  await db
    .update(pharmacies)
    .set({ ...values, ...(password ? { passwordHash: await hashPassword(password) } : {}) })
    .where(eq(pharmacies.id, id));
  if (password || (values.status && values.status !== 'active'))
    await closeAllPortalSessions('pharmacy', id);
  return getAdminPharmacy(id);
}
export async function getAdminPharmacy(id: string) {
  const [item] = await db.select().from(pharmacies).where(eq(pharmacies.id, id)).limit(1);
  if (!item) throw notFound('Pharmacy');
  const [productItems, orderItems, categories, [orderCount]] = await Promise.all([
    db
      .select({
        id: products.id,
        pharmacyId: products.pharmacyId,
        categoryId: products.categoryId,
        categoryName: productCategories.name,
        name: products.name,
        description: products.description,
        amount: products.amount,
        purchasePrice: products.purchasePrice,
        discount: products.discount,
        stockRemaining: products.stockRemaining,
        images: products.images,
        status: products.status,
        createdAt: products.createdAt,
      })
      .from(products)
      .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(eq(products.pharmacyId, id))
      .orderBy(products.name),
    db
      .select()
      .from(orders)
      .where(eq(orders.pharmacyId, id))
      .orderBy(desc(orders.createdAt))
      .limit(50),
    db.select().from(productCategories).orderBy(productCategories.name),
    db.select({ value: count() }).from(orders).where(eq(orders.pharmacyId, id)),
  ]);
  return {
    ...item,
    products: productItems,
    recentOrders: orderItems,
    categories,
    orderCount: orderCount?.value ?? 0,
  };
}
type ProductInput = {
  pharmacyId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  amount: number;
  purchasePrice?: number | null;
  discount?: number;
  stockRemaining?: number;
  images?: string[];
  status?: string;
};
export async function createProduct(input: ProductInput) {
  const [pharmacy] = await db
    .select({ id: pharmacies.id })
    .from(pharmacies)
    .where(eq(pharmacies.id, input.pharmacyId))
    .limit(1);
  if (!pharmacy) throw notFound('Pharmacy');
  const id = newId();
  await db.insert(products).values({ id, ...input, images: input.images ?? [] });
  const [item] = await db.select().from(products).where(eq(products.id, id));
  return item;
}
export async function updateProduct(id: string, input: Partial<Omit<ProductInput, 'pharmacyId'>>) {
  const [item] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  if (!item) throw notFound('Product');
  await db.update(products).set(input).where(eq(products.id, id));
  const [updated] = await db.select().from(products).where(eq(products.id, id));
  return updated;
}
export async function importProducts(
  pharmacyId: string,
  items: Array<Omit<ProductInput, 'pharmacyId'> & { id?: string }>,
) {
  const [pharmacy] = await db
    .select({ id: pharmacies.id })
    .from(pharmacies)
    .where(eq(pharmacies.id, pharmacyId))
    .limit(1);
  if (!pharmacy) throw notFound('Pharmacy');
  let created = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const { id, ...input } of items) {
      if (id) {
        const [existing] = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.id, id), eq(products.pharmacyId, pharmacyId)))
          .limit(1);
        if (!existing) throw badRequest(`Product ${id} does not belong to this pharmacy`);
        await tx.update(products).set(input).where(eq(products.id, id));
        updated += 1;
      } else {
        await tx
          .insert(products)
          .values({ id: newId(), pharmacyId, ...input, images: input.images ?? [] });
        created += 1;
      }
    }
  });
  return { created, updated, total: items.length };
}
export const listProductCategories = () =>
  db
    .select({
      id: productCategories.id,
      name: productCategories.name,
      productCount: count(products.id),
    })
    .from(productCategories)
    .leftJoin(products, eq(products.categoryId, productCategories.id))
    .groupBy(productCategories.id, productCategories.name)
    .orderBy(productCategories.name);
export async function createProductCategory(input: { name: string }) {
  const [existing] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(sql`lower(${productCategories.name}) = lower(${input.name})`)
    .limit(1);
  if (existing) throw badRequest('A category with this name already exists');
  const id = newId();
  await db.insert(productCategories).values({ id, name: input.name });
  return { id, name: input.name, productCount: 0 };
}
export async function updateProductCategory(id: string, input: { name: string }) {
  const [category] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(eq(productCategories.id, id))
    .limit(1);
  if (!category) throw notFound('Product category');
  const [duplicate] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(
      and(
        sql`lower(${productCategories.name}) = lower(${input.name})`,
        sql`${productCategories.id} <> ${id}`,
      ),
    )
    .limit(1);
  if (duplicate) throw badRequest('A category with this name already exists');
  await db.update(productCategories).set({ name: input.name }).where(eq(productCategories.id, id));
  return { id, name: input.name };
}
export async function deleteProductCategory(id: string) {
  const [category] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(eq(productCategories.id, id))
    .limit(1);
  if (!category) throw notFound('Product category');
  await db.delete(productCategories).where(eq(productCategories.id, id));
  return { deleted: true };
}

export async function listOrders(query: ListQuery) {
  const term = searchTerm(query.search);
  const where = and(
    query.status
      ? eq(orders.status, query.status as (typeof orders.status.enumValues)[number])
      : undefined,
    term
      ? or(
          like(orders.trackingId, term),
          like(patient.firstName, term),
          like(patient.lastName, term),
          like(pharmacies.name, term),
        )
      : undefined,
  );
  const [items, [total], [summary]] = await Promise.all([
    db
      .select({
        id: orders.id,
        trackingId: orders.trackingId,
        patientId: orders.userId,
        patientName: fullName(patient.firstName, patient.lastName),
        pharmacyId: orders.pharmacyId,
        pharmacyName: pharmacies.name,
        status: orders.status,
        totalAmount: orders.totalAmount,
        deliveryFee: orders.deliveryFee,
        address: orders.address,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(patient, eq(patient.id, orders.userId))
      .innerJoin(pharmacies, eq(pharmacies.id, orders.pharmacyId))
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ value: count() })
      .from(orders)
      .innerJoin(patient, eq(patient.id, orders.userId))
      .innerJoin(pharmacies, eq(pharmacies.id, orders.pharmacyId))
      .where(where),
    db
      .select({
        active: sql<number>`sum(case when ${orders.status} in ('pending', 'processing', 'delivering') then 1 else 0 end)`,
        awaitingPayment: sql<number>`sum(case when ${orders.status} = 'awaiting_payment' then 1 else 0 end)`,
        completed: sql<number>`sum(case when ${orders.status} = 'completed' then 1 else 0 end)`,
        cancelled: sql<number>`sum(case when ${orders.status} = 'cancelled' then 1 else 0 end)`,
        revenue: sql<number>`coalesce(sum(case when ${orders.status} = 'completed' then ${orders.totalAmount} else 0 end), 0)`,
      })
      .from(orders),
  ]);
  return {
    items,
    total: total?.value ?? 0,
    summary: {
      active: Number(summary?.active ?? 0),
      awaitingPayment: Number(summary?.awaitingPayment ?? 0),
      completed: Number(summary?.completed ?? 0),
      cancelled: Number(summary?.cancelled ?? 0),
      revenue: Number(summary?.revenue ?? 0),
    },
    limit: query.limit,
    offset: query.offset,
  };
}

export async function setOrderStatus(
  id: string,
  status: (typeof orders.status.enumValues)[number],
) {
  const [item] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, id)).limit(1);
  if (!item) throw notFound('Order');
  await db.update(orders).set({ status }).where(eq(orders.id, id));
  return { id, status };
}

export async function listLabResults(query: ListQuery) {
  const term = searchTerm(query.search);
  const where = and(
    query.status
      ? eq(labResults.status, query.status as (typeof labResults.status.enumValues)[number])
      : undefined,
    term
      ? or(like(users.firstName, term), like(users.lastName, term), like(users.email, term))
      : undefined,
  );
  const [items, [total], [pending], [awaitingPayment], [completed]] = await Promise.all([
    db
      .select({
        id: labResults.id,
        patientId: labResults.userId,
        patientName: fullName(users.firstName, users.lastName),
        patientEmail: users.email,
        status: labResults.status,
        price: labResults.price,
        currency: labResults.currency,
        resultUrl: labResults.resultUrl,
        opened: labResults.opened,
        createdAt: labResults.createdAt,
      })
      .from(labResults)
      .innerJoin(users, eq(users.id, labResults.userId))
      .where(where)
      .orderBy(desc(labResults.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ value: count() })
      .from(labResults)
      .innerJoin(users, eq(users.id, labResults.userId))
      .where(where),
    db.select({ value: count() }).from(labResults).where(eq(labResults.status, 'pending')),
    db.select({ value: count() }).from(labResults).where(eq(labResults.status, 'awaiting_payment')),
    db.select({ value: count() }).from(labResults).where(eq(labResults.status, 'completed')),
  ]);
  return {
    items: await withResolvedUrls(items, 'resultUrl'),
    total: total?.value ?? 0,
    summary: {
      pending: pending?.value ?? 0,
      awaitingPayment: awaitingPayment?.value ?? 0,
      completed: completed?.value ?? 0,
    },
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getLabResult(id: string) {
  const [item] = await db
    .select({
      id: labResults.id,
      patientId: labResults.userId,
      patientName: fullName(users.firstName, users.lastName),
      patientEmail: users.email,
      patientPhone: users.phoneNumber,
      status: labResults.status,
      price: labResults.price,
      currency: labResults.currency,
      resultUrl: labResults.resultUrl,
      testName: labResults.testName,
      laboratoryName: labResults.laboratoryName,
      referenceNumber: labResults.referenceNumber,
      sampleCollectedAt: labResults.sampleCollectedAt,
      resultDate: labResults.resultDate,
      interpretation: labResults.interpretation,
      adminResponse: labResults.adminResponse,
      reviewedAt: labResults.reviewedAt,
      opened: labResults.opened,
      createdAt: labResults.createdAt,
      updatedAt: labResults.updatedAt,
    })
    .from(labResults)
    .innerJoin(users, eq(users.id, labResults.userId))
    .where(eq(labResults.id, id))
    .limit(1);
  if (!item) throw notFound('Lab result');
  const files = await db
    .select({ fileUrl: labResultFiles.fileUrl, fileType: labResultFiles.fileType })
    .from(labResultFiles)
    .where(eq(labResultFiles.labResultId, id));
  return {
    ...item,
    resultUrl: await resolveFileUrl(item.resultUrl),
    files: await withResolvedUrls(files, 'fileUrl'),
  };
}

type LabResultUpdate = {
  status?: (typeof labResults.status.enumValues)[number];
  resultUrl?: string;
  testName?: string | null;
  laboratoryName?: string | null;
  referenceNumber?: string | null;
  sampleCollectedAt?: Date | null;
  resultDate?: Date | null;
  interpretation?: string | null;
  adminResponse?: string | null;
};
export async function updateLabResult(id: string, input: LabResultUpdate) {
  const [item] = await db
    .select({ id: labResults.id })
    .from(labResults)
    .where(eq(labResults.id, id))
    .limit(1);
  if (!item) throw notFound('Lab result');
  await db
    .update(labResults)
    .set({ ...input, ...(input.status === 'completed' ? { reviewedAt: new Date() } : {}) })
    .where(eq(labResults.id, id));
  return getLabResult(id);
}

export async function listPayments(query: ListQuery) {
  const term = searchTerm(query.search);
  const where = and(
    query.status
      ? eq(payments.status, query.status as (typeof payments.status.enumValues)[number])
      : undefined,
    term
      ? or(
          like(payments.reference, term),
          like(users.firstName, term),
          like(users.lastName, term),
          like(users.email, term),
        )
      : undefined,
  );
  const items = await db
    .select({
      id: payments.id,
      reference: payments.reference,
      patientId: payments.userId,
      patientName: fullName(users.firstName, users.lastName),
      provider: payments.provider,
      method: payments.method,
      purpose: payments.purpose,
      status: payments.status,
      amount: payments.amount,
      currency: payments.currency,
      customerConfirmedAt: payments.customerConfirmedAt,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(users, eq(users.id, payments.userId))
    .where(where)
    .orderBy(desc(payments.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db
    .select({ value: count() })
    .from(payments)
    .where(
      query.status
        ? eq(payments.status, query.status as (typeof payments.status.enumValues)[number])
        : undefined,
    );
  return { items, total: total?.value ?? 0, limit: query.limit, offset: query.offset };
}

export async function setPaymentStatus(
  id: string,
  status: (typeof payments.status.enumValues)[number],
  failureReason?: string | null,
) {
  const [item] = await db
    .select({ id: payments.id, purpose: payments.purpose, purposeRefId: payments.purposeRefId })
    .from(payments)
    .where(eq(payments.id, id))
    .limit(1);
  if (!item) throw notFound('Payment');
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        status,
        failureReason,
        ...(status === 'succeeded' ? { paidAt: new Date() } : { paidAt: null }),
      })
      .where(eq(payments.id, id));
    if (item.purpose === 'appointment' && item.purposeRefId)
      await tx
        .update(appointments)
        .set({ isPaid: status === 'succeeded', paidAt: status === 'succeeded' ? new Date() : null })
        .where(eq(appointments.id, item.purposeRefId));
  });
  return { id, status };
}
