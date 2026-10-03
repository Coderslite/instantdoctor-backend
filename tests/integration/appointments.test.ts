import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../../src/db/client.js';
import { appSettings, appointments, users } from '../../src/db/schema/index.js';
import { api, auth, createDoctor, createPackage, createUser, inHours, resetDatabase } from '../helpers.js';

afterAll(() => closeDatabase());

const book = (token: string, key: string, body: object) =>
  api().post('/v1/appointments').set(auth(token)).set('Idempotency-Key', key).send(body);

describe('POST /v1/appointments', () => {
  let packageId: string;

  beforeEach(async () => {
    await resetDatabase();
    packageId = await createPackage({ amountUsd: 10, durationSeconds: 3600 });
  });

  it('requires an Idempotency-Key', async () => {
    const patient = await createUser();
    const res = await api()
      .post('/v1/appointments')
      .set(auth(patient.token))
      .send({ packageId, startTime: inHours(2) });
    expect(res.status).toBe(400);
  });

  it('prices the booking server-side from the patient region', async () => {
    const patient = await createUser({ country: 'NG', currency: 'NGN' });
    const doctor = await createDoctor();
    const res = await book(patient.token, 'key-price-0001', { packageId, doctorId: doctor.id, startTime: inHours(2) });
    expect(res.status).toBe(201);
    // $10 -> 50% regional discount -> x1500 NGN
    expect(res.body).toMatchObject({ price: 7500, currency: 'NGN', isPaid: false, status: 'pending' });
  });

  it('replays the original response for a retried key and books only once', async () => {
    const patient = await createUser();
    const doctor = await createDoctor();
    const body = { packageId, doctorId: doctor.id, startTime: inHours(3), symptoms: ['Fever'] };

    const first = await book(patient.token, 'retry-key-0001', body);
    const second = await book(patient.token, 'retry-key-0001', body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const rows = await db.select().from(appointments).where(eq(appointments.userId, patient.id));
    expect(rows).toHaveLength(1);
  });

  it('rejects reuse of a key with a different body', async () => {
    const patient = await createUser();
    const doctor = await createDoctor();
    await book(patient.token, 'reuse-key-0001', { packageId, doctorId: doctor.id, startTime: inHours(3) });
    const res = await book(patient.token, 'reuse-key-0001', { packageId, doctorId: doctor.id, startTime: inHours(5) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('collapses concurrent duplicate submissions into one booking', async () => {
    const patient = await createUser();
    const doctor = await createDoctor();
    const body = { packageId, doctorId: doctor.id, startTime: inHours(4) };

    const results = await Promise.all(Array.from({ length: 5 }, () => book(patient.token, 'double-tap-0001', body)));

    const ok = results.filter((r) => r.status === 201);
    const inFlight = results.filter((r) => r.status === 409 && r.body.error.code === 'IDEMPOTENCY_IN_PROGRESS');
    expect(ok.length + inFlight.length).toBe(5);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    const rows = await db.select().from(appointments).where(eq(appointments.userId, patient.id));
    expect(rows).toHaveLength(1);
  });

  it('never double-books a doctor under concurrent requests from different patients', async () => {
    const doctor = await createDoctor();
    const patients = await Promise.all(Array.from({ length: 6 }, () => createUser()));
    const startTime = inHours(6);

    const results = await Promise.all(
      patients.map((p, i) => book(p.token, `slot-race-000${i}`, { packageId, doctorId: doctor.id, startTime })),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(5);
    conflicts.forEach((r) => expect(r.body.error.code).toBe('SLOT_UNAVAILABLE'));
  });

  it('allows back-to-back slots (half-open intervals)', async () => {
    const doctor = await createDoctor();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const start = inHours(8);
    const next = new Date(start.getTime() + 3600_000);
    expect((await book(a.token, 'adjacent-0001', { packageId, doctorId: doctor.id, startTime: start })).status).toBe(201);
    expect((await book(b.token, 'adjacent-0002', { packageId, doctorId: doctor.id, startTime: next })).status).toBe(201);
  });

  it('releases an unpaid slot once its hold expires', async () => {
    const doctor = await createDoctor();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const startTime = inHours(10);
    const first = await book(a.token, 'hold-key-0001', { packageId, doctorId: doctor.id, startTime });
    await db.update(appointments).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(appointments.id, first.body.id));
    expect((await book(b.token, 'hold-key-0002', { packageId, doctorId: doctor.id, startTime })).status).toBe(201);
  });

  it('creates an open request when no doctor is chosen', async () => {
    const patient = await createUser();
    const res = await book(patient.token, 'open-req-0001', { packageId, startTime: inHours(2) });
    expect(res.status).toBe(201);
    expect(res.body.doctor).toBeNull();
  });

  it('lets a patient use the free trial exactly once, even concurrently', async () => {
    const trialDoctor = await createDoctor({ id: process.env.TRIAL_DOCTOR_ID ?? 'p3rzihnMKVQVU6pIroy1nQ5anXK2' });
    await db.insert(appSettings).values({ key: 'app', value: { trial: true, trialDoctor: trialDoctor.id } });
    const patient = await createUser();

    const results = await Promise.all(
      [0, 1, 2].map((i) => book(patient.token, `trial-key-000${i}`, { isTrial: true, startTime: inHours(12 + i) })),
    );

    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ isTrial: true, isPaid: true, price: 0 });
    results
      .filter((r) => r.status !== 201)
      .forEach((r) => expect(r.body.error.code).toBe('TRIAL_UNAVAILABLE'));
    const [user] = await db.select().from(users).where(eq(users.id, patient.id));
    expect(user!.isTrialAvailable).toBe(false);
  });
});

describe('POST /v1/appointments/:id/accept', () => {
  beforeEach(() => resetDatabase());

  it('lets exactly one doctor claim an open request', async () => {
    const packageId = await createPackage();
    const patient = await createUser();
    const doctors = await Promise.all(Array.from({ length: 4 }, () => createDoctor()));
    const booked = await book(patient.token, 'claim-race-0001', { packageId, startTime: inHours(3) });
    await db.update(appointments).set({ isPaid: true }).where(eq(appointments.id, booked.body.id));

    const results = await Promise.all(
      doctors.map((d) => api().post(`/v1/appointments/${booked.body.id}/accept`).set(auth(d.token))),
    );

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.body).toMatchObject({ status: 'active' });
    results.filter((r) => r.status !== 200).forEach((r) => expect(r.body.error.code).toBe('ALREADY_TAKEN'));
  });

  it('refuses an unpaid request', async () => {
    const packageId = await createPackage();
    const patient = await createUser();
    const doctor = await createDoctor();
    const booked = await book(patient.token, 'claim-unpaid-01', { packageId, startTime: inHours(3) });
    const res = await api().post(`/v1/appointments/${booked.body.id}/accept`).set(auth(doctor.token));
    expect(res.status).toBe(422);
  });
});
