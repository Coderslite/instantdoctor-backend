import { and, asc, count, eq, gt, gte, lt, notInArray, sql, sum } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointments,
  HMO_SERVICES,
  hmoClaims,
  hmoEnrollees,
  hmoInvoices,
  hmoPlans,
  hmoUsers,
  labResults,
  orders,
  type HmoService,
} from '../../db/schema/index.js';
import type { hmos } from '../../db/schema/index.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { round2 } from '../../lib/money.js';
import { signHmoAccessToken } from '../../lib/tokens.js';
import {
  closeAllPortalSessions,
  closePortalSession,
  openPortalSession,
  rotatePortalSession,
} from '../auth/portal-sessions.js';
import type { Actor } from '../hmo/hmo.activity.js';
import { getHmo, pricePreview, requireHmo, updateHmo } from '../hmo/hmo.agreements.js';
import { listClaims, serviceStands } from '../hmo/hmo.claims.js';
import { requireUser } from '../hmo/hmo.users.js';
import type { profileSchema } from './hmo-portal.schemas.js';

/**
 * The HMO's own view of the partnership. Reads and writes go through the
 * HMO-scoped services the admin uses, with the HMO taken from the login;
 * this file adds sign-in, the dashboard, and what the HMO may not see.
 */

// ── What the HMO sees ───────────────────────────────────────────────────────
// Doctor pay is Instant Doctor's business, admin notes are internal, and app
// account details belong to the patient: the HMO only learns whether a member
// has linked the app.

type HmoRow = typeof hmos.$inferSelect;
export const portalHmo = ({ notes: _notes, ...hmo }: HmoRow) => hmo;

export const portalEnrollee = <T extends { userId: string | null; account?: unknown }>({
  userId,
  account: _account,
  ...enrollee
}: T) => ({ ...enrollee, linked: userId !== null });

export const portalClaim = <T extends { doctorEarning?: unknown }>({
  doctorEarning: _doctorEarning,
  ...claim
}: T) => claim;

export const portalInvoice = <T extends { createdBy?: unknown }>({
  createdBy: _createdBy,
  ...invoice
}: T) => invoice;

export async function agreement(hmoId: string) {
  const { plans } = await getHmo(hmoId);
  return {
    plans: plans.map((plan) => ({
      ...plan,
      rules: plan.rules.map(({ doctorEarning: _doctorEarning, ...rule }) => rule),
    })),
  };
}

export async function planPricePreview(hmoId: string, planId: string) {
  const preview = await pricePreview(hmoId, planId);
  return {
    ...preview,
    consultations: preview.consultations.map(({ doctorEarning: _doctorEarning, ...line }) => line),
  };
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

const issueSession = (
  user: { id: string; hmoId: string; sessionVersion: number },
  refreshToken: string,
) => ({
  accessToken: signHmoAccessToken({
    sub: user.id,
    hmoId: user.hmoId,
    sessionVersion: user.sessionVersion,
  }),
  refreshToken,
  tokenType: 'Bearer' as const,
});

export async function me(hmoId: string, userId: string) {
  const [account, hmo] = await Promise.all([requireUser(hmoId, userId), requireHmo(hmoId)]);
  return { account, hmo: portalHmo(hmo) };
}

export async function login(email: string, password: string, userAgent?: string) {
  const [user] = await db
    .select()
    .from(hmoUsers)
    .where(eq(hmoUsers.email, email.toLowerCase()))
    .limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash)))
    throw unauthorized('Invalid email or password');
  if (user.status !== 'active')
    throw forbidden('This account has been deactivated. Ask your HMO admin to restore it.');
  await db.update(hmoUsers).set({ lastLoginAt: new Date() }).where(eq(hmoUsers.id, user.id));
  return {
    ...(await me(user.hmoId, user.id)),
    session: issueSession(user, await openPortalSession('hmo_user', user.id, userAgent)),
  };
}

export async function refreshSession(refreshToken: string, userAgent?: string) {
  const rotated = await rotatePortalSession('hmo_user', refreshToken, userAgent);
  const [user] = await db
    .select({
      id: hmoUsers.id,
      hmoId: hmoUsers.hmoId,
      status: hmoUsers.status,
      sessionVersion: hmoUsers.sessionVersion,
    })
    .from(hmoUsers)
    .where(eq(hmoUsers.id, rotated.subjectId))
    .limit(1);
  if (!user || user.status !== 'active') {
    await closeAllPortalSessions('hmo_user', rotated.subjectId);
    throw unauthorized('Your session has ended. Please sign in again.');
  }
  return { session: issueSession(user, rotated.refreshToken) };
}

export const logout = (refreshToken: string) => closePortalSession('hmo_user', refreshToken);

/** Signs out every other session and returns a fresh one for this device. */
export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  userAgent?: string,
) {
  const [user] = await db.select().from(hmoUsers).where(eq(hmoUsers.id, userId)).limit(1);
  if (!user) throw unauthorized();
  if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
    throw badRequest('Your current password is incorrect', [
      { path: 'currentPassword', message: 'incorrect' },
    ]);
  await db
    .update(hmoUsers)
    .set({
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      sessionVersion: sql`${hmoUsers.sessionVersion} + 1`,
    })
    .where(eq(hmoUsers.id, userId));
  await closeAllPortalSessions('hmo_user', userId);
  const [fresh] = await db
    .select({ id: hmoUsers.id, hmoId: hmoUsers.hmoId, sessionVersion: hmoUsers.sessionVersion })
    .from(hmoUsers)
    .where(eq(hmoUsers.id, userId));
  return {
    updated: true,
    session: issueSession(fresh!, await openPortalSession('hmo_user', userId, userAgent)),
  };
}

export async function updateProfile(
  hmoId: string,
  input: z.infer<typeof profileSchema>,
  actor: Actor,
) {
  await updateHmo(hmoId, input, actor);
  return portalHmo(await requireHmo(hmoId));
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/** Months and years are counted in Lagos time (WAT, UTC+1), as on invoices. */
const WAT_MS = 3_600_000;
const lagosMonthStart = (now: Date, monthsBack = 0) => {
  const local = new Date(now.getTime() + WAT_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsBack, 1) - WAT_MS);
};
const lagosYearStart = (now: Date) =>
  new Date(Date.UTC(new Date(now.getTime() + WAT_MS).getUTCFullYear(), 0, 1) - WAT_MS);
const monthKey = (start: Date) => new Date(start.getTime() + WAT_MS).toISOString().slice(0, 7);

const TREND_MONTHS = 6;
const EXPIRY_WINDOW_MS = 30 * 24 * 3_600_000;

export async function dashboard(hmoId: string) {
  await requireHmo(hmoId);
  const now = new Date();
  const trendFrom = lagosMonthStart(now, TREND_MONTHS - 1);
  // Constants are inlined (not bound) so MySQL sees the SELECT and GROUP BY expressions as equal.
  const month = sql<string>`DATE_FORMAT(CONVERT_TZ(${hmoClaims.serviceDate}, '+00:00', '+01:00'), '%Y-%m')`;

  const [roster, [joined], [expiring], plans, trend, [unbilled], [outstanding], [paid], recent] =
    await Promise.all([
      db
        .select({
          status: hmoEnrollees.status,
          n: count(),
          linked: sql<number>`SUM(${hmoEnrollees.userId} IS NOT NULL)`.mapWith(Number),
        })
        .from(hmoEnrollees)
        .where(eq(hmoEnrollees.hmoId, hmoId))
        .groupBy(hmoEnrollees.status),
      db
        .select({ n: count() })
        .from(hmoEnrollees)
        .where(
          and(eq(hmoEnrollees.hmoId, hmoId), gte(hmoEnrollees.createdAt, lagosMonthStart(now))),
        ),
      db
        .select({ n: count() })
        .from(hmoEnrollees)
        .where(
          and(
            eq(hmoEnrollees.hmoId, hmoId),
            eq(hmoEnrollees.status, 'active'),
            gt(hmoEnrollees.validTo, now),
            lt(hmoEnrollees.validTo, new Date(now.getTime() + EXPIRY_WINDOW_MS)),
          ),
        ),
      db
        .select({
          id: hmoPlans.id,
          name: hmoPlans.name,
          isActive: hmoPlans.isActive,
          members: sql<number>`COUNT(${hmoEnrollees.id})`.mapWith(Number),
        })
        .from(hmoPlans)
        .leftJoin(
          hmoEnrollees,
          and(eq(hmoEnrollees.planId, hmoPlans.id), eq(hmoEnrollees.status, 'active')),
        )
        .where(eq(hmoPlans.hmoId, hmoId))
        .groupBy(hmoPlans.id)
        .orderBy(asc(hmoPlans.name)),
      // Utilisation counts services that happened: paid, not cancelled, delivered.
      db
        .select({
          month,
          service: hmoClaims.service,
          n: count(),
          hmoAmount: sum(hmoClaims.hmoAmount).mapWith(Number),
          patientAmount: sum(hmoClaims.patientAmount).mapWith(Number),
        })
        .from(hmoClaims)
        .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
        .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
        .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
        .where(
          and(
            eq(hmoClaims.hmoId, hmoId),
            gte(hmoClaims.serviceDate, trendFrom),
            notInArray(hmoClaims.status, ['void', 'rejected']),
            serviceStands(),
          ),
        )
        .groupBy(month, hmoClaims.service),
      db
        .select({ n: count(), amount: sum(hmoClaims.hmoAmount).mapWith(Number) })
        .from(hmoClaims)
        .leftJoin(appointments, eq(appointments.id, hmoClaims.appointmentId))
        .leftJoin(labResults, eq(labResults.id, hmoClaims.labResultId))
        .leftJoin(orders, eq(orders.id, hmoClaims.orderId))
        .where(
          and(
            eq(hmoClaims.hmoId, hmoId),
            eq(hmoClaims.status, 'unbilled'),
            gt(hmoClaims.hmoAmount, 0),
            serviceStands(),
          ),
        ),
      db
        .select({
          n: count(),
          amount: sum(hmoInvoices.totalAmount).mapWith(Number),
          overdue: sql<number>`SUM(${hmoInvoices.dueAt} < ${now})`.mapWith(Number),
          overdueAmount:
            sql<number>`SUM(CASE WHEN ${hmoInvoices.dueAt} < ${now} THEN ${hmoInvoices.totalAmount} ELSE 0 END)`.mapWith(
              Number,
            ),
        })
        .from(hmoInvoices)
        .where(and(eq(hmoInvoices.hmoId, hmoId), eq(hmoInvoices.status, 'issued'))),
      db
        .select({ amount: sum(hmoInvoices.totalAmount).mapWith(Number) })
        .from(hmoInvoices)
        .where(
          and(
            eq(hmoInvoices.hmoId, hmoId),
            eq(hmoInvoices.status, 'paid'),
            gte(hmoInvoices.paidAt, lagosYearStart(now)),
          ),
        ),
      listClaims(hmoId, { limit: 6, offset: 0 }),
    ]);

  const byStatus = (status: string) => roster.find((r) => r.status === status);
  const months = Array.from({ length: TREND_MONTHS }, (_, i) =>
    monthKey(lagosMonthStart(now, TREND_MONTHS - 1 - i)),
  );
  const emptyServices = () =>
    Object.fromEntries(HMO_SERVICES.map((s) => [s, { claims: 0, hmoAmount: 0 }])) as Record<
      HmoService,
      { claims: number; hmoAmount: number }
    >;

  return {
    members: {
      total: roster.reduce((n, r) => n + r.n, 0),
      active: byStatus('active')?.n ?? 0,
      suspended: byStatus('suspended')?.n ?? 0,
      ended: byStatus('ended')?.n ?? 0,
      /** Active members who have linked the Instant Doctor app. */
      linked: byStatus('active')?.linked ?? 0,
      newThisMonth: joined?.n ?? 0,
      expiringSoon: expiring?.n ?? 0,
    },
    plans,
    utilisation: months.map((key) => {
      const rows = trend.filter((t) => t.month === key);
      const services = emptyServices();
      for (const r of rows)
        services[r.service] = { claims: r.n, hmoAmount: round2(r.hmoAmount ?? 0) };
      return {
        month: key,
        claims: rows.reduce((n, r) => n + r.n, 0),
        hmoAmount: round2(rows.reduce((n, r) => n + (r.hmoAmount ?? 0), 0)),
        patientAmount: round2(rows.reduce((n, r) => n + (r.patientAmount ?? 0), 0)),
        services,
      };
    }),
    billing: {
      unbilledClaims: unbilled?.n ?? 0,
      unbilledAmount: round2(unbilled?.amount ?? 0),
      outstandingInvoices: outstanding?.n ?? 0,
      outstandingAmount: round2(outstanding?.amount ?? 0),
      overdueInvoices: outstanding?.overdue ?? 0,
      overdueAmount: round2(outstanding?.overdueAmount ?? 0),
      paidThisYear: round2(paid?.amount ?? 0),
    },
    recentClaims: recent.items.map(portalClaim),
  };
}
