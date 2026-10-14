import { and, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, type Executor, type Tx } from '../../db/client.js';
import { appSettings, appointments, doctorLedger, users, type DoctorLedgerType } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { round2 } from '../../lib/money.js';
import { clearingTime } from '../payouts/payouts.settings.js';
import { getDoctorPayoutSettings } from './doctor-payouts.settings.js';

type Entry = {
  doctorId: string;
  type: DoctorLedgerType;
  amount: number;
  currency: string;
  description: string;
  appointmentId?: string | null;
  payoutId?: string | null;
  createdBy?: string | null;
  availableAt?: Date;
};

/** Serialises every balance change for one doctor (their user row is the lock). */
export async function lockDoctor(tx: Tx, doctorId: string) {
  const [row] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, doctorId)).for('update');
  if (!row || row.role !== 'doctor') throw notFound('Doctor');
}

/** Posts one ledger entry. Callers lock the doctor first when the balance matters. */
export async function post(tx: Tx, entry: Entry) {
  await tx.insert(doctorLedger).values({
    id: newId(),
    doctorId: entry.doctorId,
    type: entry.type,
    amount: round2(entry.amount),
    currency: entry.currency,
    description: entry.description.slice(0, 255),
    appointmentId: entry.appointmentId ?? null,
    payoutId: entry.payoutId ?? null,
    createdBy: entry.createdBy ?? null,
    availableAt: entry.availableAt ?? new Date(),
  });
}

export interface CurrencyBalance {
  currency: string;
  /** Everything owed. */
  balance: number;
  /** Can be paid out now. */
  available: number;
  /** Still in the clearing period. */
  pending: number;
}

/** What the doctor is owed in each currency they've earned in. */
export async function balances(doctorId: string, executor: Executor = db): Promise<CurrencyBalance[]> {
  const rows = await executor
    .select({
      currency: doctorLedger.currency,
      total: sql<string>`coalesce(sum(${doctorLedger.amount}), 0)`,
      available: sql<string>`coalesce(sum(case when ${doctorLedger.availableAt} <= utc_timestamp(3) then ${doctorLedger.amount} else 0 end), 0)`,
    })
    .from(doctorLedger)
    .where(eq(doctorLedger.doctorId, doctorId))
    .groupBy(doctorLedger.currency);
  return rows.map((r) => {
    const balance = round2(Number(r.total));
    const available = Math.max(0, round2(Number(r.available)));
    return { currency: r.currency, balance, available, pending: round2(Math.max(0, balance - available)) };
  });
}

export async function balanceIn(doctorId: string, currency: string, executor: Executor = db) {
  return (await balances(doctorId, executor)).find((b) => b.currency === currency) ?? { currency, balance: 0, available: 0, pending: 0 };
}

/**
 * Makes the ledger agree with the appointment: a completed, paid consultation
 * has credited its doctor's earning exactly once; a cancelled one (or one put
 * back in progress) has credited nothing. A patient removing a finished
 * consultation from their list ("deleted") doesn't touch what the doctor
 * earned. Call after any status or payment change, inside the same
 * transaction. Idempotent.
 */
export async function settleAppointment(tx: Tx, appointmentId: string) {
  const [a] = await tx
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      status: appointments.status,
      isPaid: appointments.isPaid,
      isTrial: appointments.isTrial,
      earning: appointments.doctorEarning,
      converted: appointments.doctorEarningConverted,
      earningCurrency: appointments.doctorEarningCurrency,
      currency: appointments.currency,
      packageLabel: appointments.packageLabel,
      startTime: appointments.startTime,
    })
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .for('update');
  if (!a?.doctorId || a.status === 'deleted') return;
  await lockDoctor(tx, a.doctorId);
  const currency = a.earningCurrency ?? a.currency ?? 'NGN';
  const amount = a.earningCurrency ? (a.converted ?? 0) : (a.earning ?? 0);
  const owed = a.status === 'completed' && a.isPaid && !a.isTrial ? round2(amount) : 0;
  const [row] = await tx
    .select({ net: sql<string>`coalesce(sum(${doctorLedger.amount}), 0)` })
    .from(doctorLedger)
    .where(and(eq(doctorLedger.appointmentId, appointmentId), inArray(doctorLedger.type, ['earning', 'earning_reversal'])));
  const net = round2(Number(row?.net ?? 0));
  if (Math.abs(owed - net) < 0.005) return;
  const day = a.startTime.toISOString().slice(0, 10);
  if (owed > net) {
    const { clearingHour } = await getDoctorPayoutSettings(tx);
    await post(tx, {
      doctorId: a.doctorId,
      type: 'earning',
      amount: owed - net,
      currency,
      description: `${a.packageLabel ?? 'Consultation'} on ${day}`,
      appointmentId,
      availableAt: clearingTime(new Date(), clearingHour),
    });
  } else {
    await post(tx, {
      doctorId: a.doctorId,
      type: 'earning_reversal',
      amount: owed - net,
      currency,
      description: `${a.packageLabel ?? 'Consultation'} on ${day} was ${a.status === 'cancelled' ? 'cancelled' : 'reopened'}`,
      appointmentId,
    });
  }
}

const LEDGER_START_KEY = 'doctor_ledger_started_at';

/** When doctor earnings tracking began; consultations before it were paid outside the ledger. */
export async function ledgerStart(): Promise<Date> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LEDGER_START_KEY)).limit(1);
  if (row && typeof row.value === 'string') return new Date(row.value);
  const now = new Date();
  await db.insert(appSettings).values({ key: LEDGER_START_KEY, value: now.toISOString() }).onDuplicateKeyUpdate({ set: { key: LEDGER_START_KEY } });
  return now;
}

/**
 * Safety net for any path that completed a consultation without settling it:
 * credits completed, paid consultations (since tracking began) with no earning yet.
 */
export async function sweepUnsettledAppointments(limit = 200) {
  const start = await ledgerStart();
  const missing = await db
    .select({ id: appointments.id })
    .from(appointments)
    .leftJoin(doctorLedger, and(eq(doctorLedger.appointmentId, appointments.id), eq(doctorLedger.type, 'earning')))
    .where(
      and(
        eq(appointments.status, 'completed'),
        eq(appointments.isPaid, true),
        eq(appointments.isTrial, false),
        isNotNull(appointments.doctorId),
        or(gt(appointments.doctorEarning, 0), gt(appointments.doctorEarningConverted, 0)),
        gte(appointments.startTime, start),
        isNull(doctorLedger.id),
      ),
    )
    .limit(limit);
  for (const { id } of missing) await db.transaction((tx) => settleAppointment(tx, id));
  return missing.length;
}
