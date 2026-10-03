# Instant Doctor API

Core backend for the Instant Doctor patient app. It replaces the data layer that used to live
inside the Flutter app (direct Firestore reads/writes) with a server-side REST + WebSocket API
on MySQL.

| Concern | Choice |
| --- | --- |
| Runtime | Node.js ≥ 20, TypeScript (strict, ESM) |
| HTTP | Express 5, Zod validation, Helmet, rate limiting |
| Database | MySQL 8 locally, TiDB Cloud live (MySQL-compatible), via Drizzle ORM + `mysql2` |
| Realtime | Socket.IO (replaces Firestore `snapshots()` streams) |
| Auth | Email/password (bcrypt) + Google + Apple, JWT access tokens, rotating refresh tokens |
| Payments | Stripe, Paystack, Flutterwave behind one provider interface |
| Push / Mail | FCM via `firebase-admin`; email via the existing `instantdoctorapi` mail endpoints |
| Tests | Vitest + Supertest against a real MySQL test database |

## Getting started

```bash
cp .env.example .env          # fill in JWT_ACCESS_SECRET and provider keys
npm install
npm run db:migrate            # creates the database if needed, then tables (leaves `campaigns` untouched)
npm run dev                   # http://localhost:4000, health at /health
```

MAMP defaults are pre-filled (`mysql://root:root@127.0.0.1:8889/instant_doctor`).

## Local vs live database

`DB_TARGET` in `.env` picks the database. Every `:live` script overrides it for that one command:

| | Local (MAMP MySQL) | Live (TiDB Cloud) |
| --- | --- | --- |
| Connection | `DATABASE_URL_LOCAL` | `DATABASE_URL_LIVE` |
| Run API | `npm run dev` | `npm run dev:live` |
| Apply migrations | `npm run db:migrate` | `npm run db:migrate:live` |
| Browse data | `npm run db:studio` | `npm run db:studio:live` |
| Import Firestore | `npm run migrate:firestore` | `npm run migrate:firestore:live -- --confirm-live` |

- **TLS** is on automatically for live (TiDB Cloud requires it) and off locally. Override with
  `DATABASE_SSL=true|false`. Set `DATABASE_SSL_CA=/path/ca.pem` only for TiDB *Dedicated*;
  Serverless certificates are publicly trusted.
- **Precedence:** `DATABASE_URL`, if set, overrides `DB_TARGET`. Tests and containers use it.
  In production, set `DB_TARGET=live` + `DATABASE_URL_LIVE`, or just `DATABASE_URL`.
- **Safety:** every command logs its target (e.g. `live → gateway01…:4000/instant_doctor (TLS)`).
  Writing Firestore data to live requires `--confirm-live`.

**TiDB Cloud setup:** create a Serverless cluster and open **Connect**. Pick "General" and generate
a password, then build the URL as
`mysql://<prefix>.root:<password>@gateway01.<region>.prod.aws.tidbcloud.com:4000/instant_doctor`.
URL-encode special characters in the password. Then run `npm run db:migrate:live`; it creates the
`instant_doctor` database for you.

**TiDB compatibility:** the schema, both migrations, the Firestore import and the whole test
suite are verified against TiDB v8.5 (`pingcap/tidb` in Docker). One engine difference matters
and is handled. In a TiDB transaction, a plain `SELECT` reads the snapshot from the start of the
transaction, even after a lock has been acquired. Any check that must see rows committed by the
previous lock holder (e.g. the slot-overlap check) therefore uses `SELECT … FOR UPDATE`. Keep this
rule for new code. To re-run the suite on TiDB:

```bash
docker run -d --name tidb -p 4001:4000 pingcap/tidb:v8.5.1
mysql -h127.0.0.1 -P4001 -uroot -e "CREATE DATABASE instant_doctor_test"
DATABASE_URL=mysql://root@127.0.0.1:4001/instant_doctor_test npm test
```

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Develop / compile / run compiled (`dev:live` for TiDB) |
| `npm test` | Unit + integration tests (needs the `instant_doctor_test` database) |
| `npm run typecheck`, `npm run lint` | Static checks |
| `npm run db:generate` | Create a migration after editing `src/db/schema/*` |
| `npm run db:migrate[:live]` | Apply pending migrations |
| `npm run migrate:firestore[:live] [-- --dry-run]` | One-off Firestore → SQL data migration |

## Project layout

```
src/
  config/env.ts            validated environment (fails fast on bad config)
  db/                      Drizzle client, schema (one file per domain), migrator
  lib/                     errors, ids, money, crypto, tokens, geo, validation
  middleware/              authenticate, idempotency, error handler
  integrations/            payments/{stripe,paystack,flutterwave}, push, mailer, FX rates, storage
  realtime/gateway.ts      Socket.IO rooms & events
  modules/<domain>/        *.routes.ts (HTTP) → *.service.ts (business logic) → db
scripts/firestore-migration/  extractor, transformers, idempotent writer, report
tests/unit, tests/integration
drizzle/                   generated SQL migrations (commit these)
```

## Booking and payments

### Booking (`POST /v1/appointments`)

The client sends `packageId`, `startTime`, `complaint`, `symptoms` and an optional `doctorId`.
**The price is never accepted from the client.** It is computed server-side: package USD price,
then the 50% African regional discount, then live FX, then rounding up to a clean local amount.
This mirrors the app's `PricingService`.

- **No `doctorId`** (the app's default flow): the booking is an *open request*. Once it is paid,
  every doctor is notified and the first to call `POST /appointments/:id/accept` wins. The claim is atomic.
- **With `doctorId`**: the booking is addressed to that doctor and their calendar is checked.
- **Trial** (`isTrial: true`): the trial is consumed atomically (one per user). It is free and confirmed immediately.

Guarantees, all covered by integration tests that fire real concurrent requests:

| Risk | Mechanism |
| --- | --- |
| Double-tap / network retry creates two bookings | `Idempotency-Key` header (required) + `UNIQUE(user_id, idempotency_key)` on the row |
| Two patients book the same doctor slot | Doctor row locked `SELECT … FOR UPDATE` + half-open interval overlap check |
| Unpaid bookings block a slot forever | `hold_expires_at` (default 30 min), re-validated and extended when payment starts |
| Two doctors accept the same open request | Conditional claim under row locks; losers get `409 ALREADY_TAKEN` |
| Trial used twice | `UPDATE … WHERE is_trial_available = true` |

### Idempotency semantics

These endpoints require `Idempotency-Key: <8-128 chars>`:
`POST /appointments`, `POST /payments`, `POST /orders/checkout`, `POST /lab-results`, `POST /wallet/transfers`.

- Same key, same body: the original response is replayed with the header `Idempotent-Replayed: true`.
- Same key, different body: `422 IDEMPOTENCY_KEY_REUSED`.
- Same key while the first request is still running: `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.
- 5xx responses are not stored, so retrying the same key is safe.
- Keys are kept for 24 hours.

**Client rule:** generate one UUID per user intent (e.g. when the Pay button is first tapped) and
reuse it for every retry of that intent.

### Payments (`POST /v1/payments`)

```jsonc
// purpose: appointment | order_checkout | lab_result | wallet_topup
{ "purpose": "appointment", "referenceId": "<appointmentId>", "provider": "stripe" }
```

The response contains `payment` (with our `reference`) and a `clientAction`:

| Provider | `clientAction` | Client does |
| --- | --- | --- |
| Stripe | `{ type: "stripe_payment_sheet", clientSecret }` | `Stripe.instance.initPaymentSheet` + `presentPaymentSheet` |
| Paystack | `{ type: "redirect", authorizationUrl, accessCode }` | open the URL / Paystack SDK with `accessCode` |
| Flutterwave | `{ type: "redirect", authorizationUrl }` | open the URL in a webview |

When the sheet or webview closes, call `POST /v1/payments/{reference}/verify` and render
`status`. The client **never** marks anything as paid.

The server settles a payment exactly once, whichever arrives first: the client's verify call or
the provider webhook. The payment row is locked, the captured amount and currency are checked
against what we charged, and the purchase is fulfilled in the same transaction. Fulfillment covers:
appointment paid, doctor earning, first-booking referral commission, order stock decrement,
pharmacy split and wallet credit. A short or mismatched capture is marked `failed` and nothing is
fulfilled.

**Webhooks:** register these with each provider.

| Provider | URL | Verification |
| --- | --- | --- |
| Stripe | `POST /v1/webhooks/stripe` | `Stripe-Signature` (set `STRIPE_WEBHOOK_SECRET`) |
| Paystack | `POST /v1/webhooks/paystack` | HMAC-SHA512 of the raw body with the secret key |
| Flutterwave | `POST /v1/webhooks/flutterwave` | `verif-hash` = `FLUTTERWAVE_WEBHOOK_HASH` |

Every event is stored in `payment_webhook_events`, so redeliveries are no-ops. Status is always
re-read from the provider API instead of being trusted from the payload.

## API documentation (Swagger)

With the server running:

- **Swagger UI:** <http://localhost:4000/docs>. Click **Authorize** and paste an access token to call protected routes.
- **OpenAPI 3.1 spec:** <http://localhost:4000/openapi.json>. Import it into Postman/Insomnia, or generate a Dart client
  for the Flutter app (e.g. `openapi-generator generate -i openapi.json -g dart-dio`).

The spec is **generated from the same Zod schemas the handlers use for validation**
(`src/docs/openapi.ts`, response models in `src/docs/components.ts`), so request docs cannot
drift from behaviour. `tests/unit/openapi.test.ts` validates the document against the OpenAPI
3.1 specification. It also fails if a route is added without being documented, or if a
documented route no longer exists. **When you add a route:** put its request schema in the
module's `*.schemas.ts` and add one `op(...)` entry in `src/docs/openapi.ts`.

Set `API_DOCS_ENABLED=false` to hide the docs (e.g. on a public production host).

## API overview

All routes are under `/v1` and require `Authorization: Bearer <accessToken>` unless marked public.

| Area | Endpoints |
| --- | --- |
| Auth (public) | `POST /auth/check-email`, `/auth/otp`, `/auth/register`, `/auth/login`, `/auth/google`, `/auth/apple`, `/auth/refresh`, `/auth/logout`, `/auth/password/reset`; `POST /auth/password/change` (auth) |
| Profile | `GET/PATCH /users/me`, `PUT /users/me/fcm-token`, `PUT /users/me/presence`, `GET/POST/DELETE /users/me/saved-locations`, `GET /users/tags/:tag/availability`, `POST /users/me/referral-program`, `GET /users/:id` |
| Doctors | `GET /doctors`, `GET /doctors/least-busy`, `GET /doctors/:id`, `GET /doctors/:id/reviews` |
| Appointments | `GET /appointments/packages`, `POST /appointments`, `GET /appointments`, `GET /appointments/open` (doctor), `GET/DELETE /appointments/:id`, `POST /appointments/:id/accept` (doctor), `POST /appointments/:id/status` (doctor) |
| Chat | `GET/POST /appointments/:id/messages`, `PATCH/DELETE /appointments/:id/messages/:messageId`, `POST /appointments/:id/messages/read`, `GET /appointments/:id/messages/unread-count` |
| Clinical | `GET /appointments/:id/prescriptions`, `POST /prescriptions/:id/seen`, `GET/POST /appointments/:id/review`, `GET/POST/DELETE /reports`, `GET/POST /reports/:id/messages` |
| Payments | `POST /payments`, `GET /payments/:reference`, `POST /payments/:reference/verify` |
| Pharmacy | `GET /pharmacies?latitude&longitude&radiusKm`, `GET /pharmacies/:id[/products]`, `GET /products/categories`, `GET /products/:id`, `POST /orders/quote`, `POST /orders/checkout`, `GET /orders[/:id]` |
| Wallet & referrals | `GET /wallet`, `GET /wallet/transactions`, `POST /wallet/transfers`, `GET /referrals?month=YYYY-MM`, `GET /referrals/summary` |
| Health | `GET /lab-results/price`, `POST/GET /lab-results`, `POST /lab-results/:id/opened`, `DELETE /lab-results/:id`, `GET/POST /medications`, `GET/PATCH/DELETE /medications/:id`, `PUT /medications/:id/doses` |
| Content | `GET /health-tips/categories`, `GET /health-tips?categoryId`, `GET /health-tips/:id` (records view), `GET /health-tips/:id/related`, `POST /health-tips/:id/like`, `GET/POST/DELETE /anonymous-questions` |
| Misc | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/read-all`, `POST /waitlist`, `GET /waitlist/status`, `POST /uploads?folder=chat` (multipart `file`), `GET /settings` (public), `GET /currencies` (public), `GET /video-call/credentials` |

Errors always look like `{ "error": { "code": "SLOT_UNAVAILABLE", "message": "…", "details": … } }`.

### Realtime

Connect with `io(BASE_URL, { auth: { token: accessToken } })`. You join `user:{id}` automatically.
Emit `appointment:join` with an appointment id to receive that chat's events.

| Event | Payload | Replaces Firestore stream |
| --- | --- | --- |
| `message:new`, `message:updated`, `messages:read` | message / `{appointmentId, readerId}` | `Appointments/{id}/conversation` |
| `appointment:updated` | `{id, status, isPaid}` | `getAllAppointment` |
| `notification:new` | notification | `getUserUnSeenNotifications` |
| `payment:updated` | `{reference, status, purpose}` | (new) |

## Firestore migration

```bash
npm run migrate:firestore -- --dry-run   # transform + report, no writes
npm run migrate:firestore                # write; verifies row counts afterwards
```

The migration needs `FIREBASE_SERVICE_ACCOUNT_PATH`. It reads every collection, subcollection
and Firebase Auth user, then normalizes and upserts them in foreign-key order. It writes
`migration-report-<ts>.json` listing every skipped record and its reason.

- **Passwords:** Firestore held plaintext passwords. They are bcrypt-hashed here and plaintext is never written. Migrated users get `legacy_auth = 1`: if their first login fails locally (for example, they reset their password in Firebase after the export), the API verifies the password once against Firebase Auth (`FIREBASE_WEB_API_KEY`) and stores a fresh local hash.
- **Social logins:** Google and Apple accounts are linked through their provider UIDs from Firebase Auth (`auth_identities`), so existing users sign in to the same account.
- **Normalization:** localized country names ("nigeria", "magyarország") become ISO codes, statuses use a canonical lowercase vocabulary, medication `dailyTakenTimes` maps become `medication_doses` rows, and `GeoPoint`s become lat/lng columns.
- **Skipped records** are rows whose owner was deleted from both Firestore and Firebase Auth (deleted accounts). The report lists them.
- **Re-running** is safe (upserts) and works as a delta sync *before* cutover. Credentials of users who have already signed in to the new API are never overwritten.

## Cutover checklist

1. Freeze writes in Firestore, or put the app in maintenance mode.
2. `npm run db:migrate:live`, then `npm run migrate:firestore:live -- --confirm-live` for the final import and verification.
3. Point the mobile app at this API. The **doctor app and admin dashboard still write to Firestore** and must move to this API, or be kept in sync, before or at the same time.
4. Register the three payment webhooks and set the provider keys.
5. Keep `FIREBASE_WEB_API_KEY` set until most users have logged in once, then remove it.

## Known follow-ups

- **Chat encryption:** the app encrypts messages client-side with a static AES key that ships in
  the app binary, so the encryption gives no real protection. The API stores ciphertext opaquely
  to stay compatible. Replace it with TLS plus at-rest encryption, or real end-to-end keys.
- **Lab result price:** the app's `getFinalPrice('lab_result_standard')` resolved to 0 because the
  base price was never loaded. The API prices it from the `Charges` USD amount (`service_charges`).
- **Stock:** stock is checked at checkout and decremented on payment, but it is not reserved in
  between, so overselling is possible under contention.
- **Uploads:** stored on local disk (`UPLOAD_DIR`). Swap `integrations/storage.ts` for S3/GCS in
  production. Migrated Firebase Storage URLs keep working.
