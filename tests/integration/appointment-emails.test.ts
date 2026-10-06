import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appSettings, appointments } from '../../src/db/schema/index.js';
import { setMailSink, type OutgoingMail } from '../../src/integrations/mail/transport.js';
import { appointmentSchedule } from '../../src/integrations/mail/templates.js';
import { api, auth, createDoctor, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('appointment emails to the patient', () => {
  let outbox: OutgoingMail[];

  beforeEach(async () => {
    await resetDatabase();
    outbox = [];
    setMailSink(async (mail) => {
      outbox.push(mail);
    });
  });
  afterEach(() => setMailSink(undefined));

  const mailsFor = (event: string) => outbox.filter((m) => m.category === `appointment-${event}`);

  async function paidOpenRequest() {
    const patient = await createUser({ email: 'ada@example.com', firstName: 'Ada', country: 'NG', currency: 'NGN' });
    const packageId = await createPackage({ name: 'Standard' });
    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'mail-booking-01')
      .set('X-Timezone', 'Africa/Lagos')
      .send({ packageId, startTime: inHours(3) });
    await db.update(appointments).set({ isPaid: true }).where(eq(appointments.id, booked.body.id));
    return { patient, appointmentId: booked.body.id as string };
  }

  it('confirms a booking in the patient\'s time zone', async () => {
    const trialDoctor = await createDoctor({ id: 'p3rzihnMKVQVU6pIroy1nQ5anXK2', firstName: 'Abraham', lastName: 'Great' });
    await db.insert(appSettings).values({ key: 'app', value: { trial: true, trialDoctor: trialDoctor.id } });
    const patient = await createUser({ email: 'ada@example.com', firstName: 'Ada' });

    const res = await api()
      .post('/api/v1/appointments')
      .set(auth(patient.token))
      .set('Idempotency-Key', 'mail-trial-0001')
      .set('X-Timezone', 'Africa/Lagos')
      .send({ isTrial: true, startTime: inHours(4) });
    expect(res.status).toBe(201);
    await settle();

    const [mail] = mailsFor('confirmed');
    expect(mail).toMatchObject({ to: 'ada@example.com' });
    expect(mail!.subject).toMatch(/^Appointment confirmed – /);
    const start = new Date(res.body.startTime);
    const expected = appointmentSchedule(start, new Date(res.body.endTime), 'Africa/Lagos');
    expect(mail!.text).toContain(`Time: ${expected.time}`);
    expect(mail!.text).toContain('Doctor: Dr Abraham Great');
    expect(mail!.text).toContain('Amount paid: Free');
  });

  it('tells an open request that a doctor is being assigned, then names the doctor who accepts', async () => {
    const { appointmentId } = await paidOpenRequest();
    const doctor = await createDoctor({ firstName: 'Abraham', lastName: 'Great' });

    await api().post(`/api/v1/appointments/${appointmentId}/accept`).set(auth(doctor.token));
    await settle();

    const [accepted] = mailsFor('accepted');
    expect(accepted).toMatchObject({ to: 'ada@example.com', subject: 'Dr Abraham Great accepted your appointment' });
    expect(accepted!.text).toContain('Doctor: Dr Abraham Great');
  });

  it('emails when the consultation is completed', async () => {
    const { appointmentId } = await paidOpenRequest();
    const doctor = await createDoctor({ firstName: 'Abraham', lastName: 'Great' });
    await api().post(`/api/v1/appointments/${appointmentId}/accept`).set(auth(doctor.token));

    await api().post(`/api/v1/appointments/${appointmentId}/status`).set(auth(doctor.token)).send({ status: 'completed' });
    await settle();

    expect(mailsFor('completed')).toEqual([
      expect.objectContaining({ to: 'ada@example.com', subject: 'Your consultation with Dr Abraham Great is complete' }),
    ]);
  });

  it('emails when the doctor cancels', async () => {
    const { appointmentId } = await paidOpenRequest();
    const doctor = await createDoctor({ firstName: 'Abraham', lastName: 'Great' });
    await api().post(`/api/v1/appointments/${appointmentId}/accept`).set(auth(doctor.token));

    await api().post(`/api/v1/appointments/${appointmentId}/status`).set(auth(doctor.token)).send({ status: 'cancelled' });
    await settle();

    const [cancelled] = mailsFor('cancelled');
    expect(cancelled!.subject).toMatch(/^Your appointment on .+ was cancelled$/);
    expect(cancelled!.text).toContain('Dr Abraham Great cancelled this appointment.');
  });

  it('sends nothing for a rejected transition', async () => {
    const { appointmentId } = await paidOpenRequest();
    const doctor = await createDoctor();
    await api().post(`/api/v1/appointments/${appointmentId}/status`).set(auth(doctor.token)).send({ status: 'completed' });
    await settle();
    expect(outbox.filter((m) => m.category.startsWith('appointment-'))).toHaveLength(0);
  });
});

describe('appointment schedule formatting', () => {
  const start = new Date('2026-10-04T08:00:00Z');
  const end = new Date('2026-10-04T08:30:00Z');

  it('renders in the patient\'s zone', () => {
    expect(appointmentSchedule(start, end, 'Africa/Lagos')).toMatchObject({
      date: 'Sunday, 4 October 2026',
      time: expect.stringMatching(/^9:00 am – 9:30 am (WAT|GMT\+1)$/),
    });
    expect(appointmentSchedule(start, end, 'America/New_York').time).toMatch(/^4:00 am – 4:30 am (EDT|GMT-4)$/);
  });

  it('falls back to UTC for a missing or invalid zone', () => {
    expect(appointmentSchedule(start, end, null).time).toMatch(/^8:00 am – 8:30 am UTC$/);
    expect(appointmentSchedule(start, end, 'Not/AZone').time).toMatch(/^8:00 am – 8:30 am UTC$/);
  });
});
