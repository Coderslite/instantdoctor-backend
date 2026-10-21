import { and, count, eq, gte, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appointments, users } from '../../db/schema/index.js';

/**
 * Growth figures for the admin overview, written to be read by someone outside
 * the team (an investor screenshot): totals, this month against last month, and
 * a 12-month trend. Months are Lagos (WAT) calendar months.
 */

const LAGOS_OFFSET = 3600_000;
const lagosMonth = (d: Date) => new Date(d.getTime() + LAGOS_OFFSET).toISOString().slice(0, 7);
const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000+01:00`);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthOf = (column: typeof users.createdAt | typeof appointments.startTime) =>
  sql<string>`DATE_FORMAT(DATE_ADD(${column}, INTERVAL 1 HOUR), '%Y-%m')`;

/** Accounts that finished signing up and weren't suspended or deleted. */
const realAccount = () =>
  and(
    eq(users.registrationStatus, 'active'),
    or(isNull(users.accountStatus), and(ne(users.accountStatus, 'suspended'), ne(users.accountStatus, 'deleted'))),
  );
const isPatient = () => and(eq(users.role, 'user'), realAccount());
const isDoctor = () => and(eq(users.role, 'doctor'), realAccount());

/** % change, or null when there's nothing to compare with. */
const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null);

export async function growthOverview() {
  const now = new Date();
  const thisMonth = lagosMonth(now);
  const lastMonth = addMonths(thisMonth, -1);
  const firstTrendMonth = addMonths(thisMonth, -11);
  const thisStart = monthStart(thisMonth);
  const lastStart = monthStart(lastMonth);
  const trendStart = monthStart(firstTrendMonth);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3600_000);
  // A fair comparison: this month so far against the same number of days of last month.
  const lastToDate = new Date(Math.min(lastStart.getTime() + (now.getTime() - thisStart.getTime()), thisStart.getTime()));

  const completed = () => eq(appointments.status, 'completed');
  const [[patients], [patientsThis], [patientsLast], [active], [doctors], [doctorsThis], [consultations], [consultThis], [consultLast], newPatients, consults] =
    await Promise.all([
      db.select({ n: count() }).from(users).where(isPatient()),
      db.select({ n: count() }).from(users).where(and(isPatient(), gte(users.createdAt, thisStart))),
      db.select({ n: count() }).from(users).where(and(isPatient(), gte(users.createdAt, lastStart), lt(users.createdAt, lastToDate))),
      db.select({ n: count() }).from(users).where(and(isPatient(), gte(users.lastSeenAt, thirtyDaysAgo))),
      db.select({ n: count() }).from(users).where(isDoctor()),
      db.select({ n: count() }).from(users).where(and(isDoctor(), gte(users.createdAt, thisStart))),
      db.select({ n: count() }).from(appointments).where(completed()),
      db.select({ n: count() }).from(appointments).where(and(completed(), gte(appointments.startTime, thisStart))),
      db.select({ n: count() }).from(appointments).where(and(completed(), gte(appointments.startTime, lastStart), lt(appointments.startTime, lastToDate))),
      db
        .select({ month: monthOf(users.createdAt), n: count() })
        .from(users)
        .where(and(isPatient(), gte(users.createdAt, trendStart)))
        .groupBy(sql`1`),
      db
        .select({ month: monthOf(appointments.startTime), n: count() })
        .from(appointments)
        .where(and(completed(), gte(appointments.startTime, trendStart), lt(appointments.startTime, now)))
        .groupBy(sql`1`),
    ]);

  const n = (row?: { n: number }) => Number(row?.n ?? 0);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(firstTrendMonth, i));
  const byMonth = (rows: { month: string; n: number }[]) => new Map(rows.map((r) => [r.month, Number(r.n)]));
  const patientsByMonth = byMonth(newPatients);
  const consultsByMonth = byMonth(consults);
  return {
    month: thisMonth,
    /** `lastMonth` figures cover the 1st of last month up to this day of the month, so the change is like for like. */
    comparedTo: { from: lastStart, to: lastToDate },
    patients: { total: n(patients), thisMonth: n(patientsThis), lastMonth: n(patientsLast), change: change(n(patientsThis), n(patientsLast)) },
    /** Opened the app or signed in within the last 30 days. */
    activePatients: { total: n(active), share: n(patients) ? Math.round((n(active) / n(patients)) * 1000) / 10 : 0 },
    doctors: { total: n(doctors), thisMonth: n(doctorsThis) },
    consultations: { total: n(consultations), thisMonth: n(consultThis), lastMonth: n(consultLast), change: change(n(consultThis), n(consultLast)) },
    trend: months.map((month) => ({ month, newPatients: patientsByMonth.get(month) ?? 0, consultations: consultsByMonth.get(month) ?? 0 })),
  };
}

/**
 * Patients who have paid for anything (consultation, medicines, lab review or
 * Family Care), and how many came back to pay again — the clearest signal that
 * people find it worth paying for.
 */
export async function payingPatients() {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*) AS paying, SUM(CASE WHEN uses >= 2 THEN 1 ELSE 0 END) AS repeating FROM (
      SELECT user_id, COUNT(*) AS uses FROM (
        SELECT user_id FROM appointments WHERE is_paid = 1 AND is_trial = 0 AND price > 0 AND status NOT IN ('cancelled', 'deleted')
        UNION ALL SELECT user_id FROM orders WHERE status NOT IN ('awaiting_payment', 'cancelled')
        UNION ALL SELECT user_id FROM lab_results WHERE status <> 'awaiting_payment' AND price > 0
        UNION ALL SELECT user_id FROM payments WHERE purpose = 'family_subscription' AND status = 'succeeded'
      ) paid GROUP BY user_id
    ) per_patient
  `)) as unknown as [{ paying: number | string; repeating: number | string | null }[]];
  const paying = Number(row[0]?.paying ?? 0);
  const repeating = Number(row[0]?.repeating ?? 0);
  return { total: paying, repeat: repeating, repeatShare: paying ? Math.round((repeating / paying) * 1000) / 10 : 0 };
}
