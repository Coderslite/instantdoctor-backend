import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { db } from '../../db/client.js';
import { appointments, users } from '../../db/schema/index.js';
import { mailer } from '../../integrations/mailer.js';
import type { AppointmentEvent } from '../../integrations/mail/templates.js';
import { logger } from '../../lib/logger.js';

const patient = alias(users, 'patient');
const doctor = alias(users, 'doctor');

export function formatAmount(amount: number, currency: string | null): string | null {
  if (!currency) return null;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export async function emailAppointmentUpdate(appointmentId: string, event: AppointmentEvent): Promise<void> {
  try {
    const [row] = await db
      .select({
        appointment: appointments,
        patient: { email: patient.email, firstName: patient.firstName },
        doctor: { firstName: doctor.firstName, lastName: doctor.lastName },
      })
      .from(appointments)
      .innerJoin(patient, eq(patient.id, appointments.userId))
      .leftJoin(doctor, eq(doctor.id, appointments.doctorId))
      .where(eq(appointments.id, appointmentId))
      .limit(1);
    if (!row) return;
    const a = row.appointment;
    const doctorName = row.doctor?.firstName
      ? `Dr ${`${row.doctor.firstName} ${row.doctor.lastName ?? ''}`.trim()}`
      : null;
    await mailer.appointmentUpdate({
      to: row.patient.email,
      event,
      firstName: row.patient.firstName,
      doctorName,
      packageName: a.packageLabel,
      isTrial: a.isTrial,
      start: a.startTime,
      end: a.endTime,
      timeZone: a.timeZone,
      amount: a.isTrial || a.price <= 0 ? 'Free' : formatAmount(a.price, a.currency),
    });
  } catch (err) {
    logger.error({ err, appointmentId, event }, 'Failed to send appointment email');
  }
}
