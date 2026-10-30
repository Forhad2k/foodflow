# FoodFlow Backend

Express 5 · TypeScript · Prisma 5 · PostgreSQL 16 + PostGIS · zod · Socket.IO (Phase 6) · Redis

> **Status: backend complete (Phases 1-8).** Auth/RBAC, customer discovery/cart/checkout/orders, restaurant-owner management, admin approval, rider onboarding and dispatch, live tracking, order chat, notifications, payments/refunds/payouts, reviews, promotions and support, plus deployment artefacts. Known limits are listed under *Scaling and known limits* in `docs/DEPLOYMENT.md`.
> Features arrive phase by phase. See `docs/ARCHITECTURE.md`. Nothing here is mocked; the one development adapter is the mail sender (`src/mail`), which logs the reset link instead of emailing it.

## Requirements
Node ≥ 20 · Docker (for Postgres/PostGIS + Redis)

## Local setup
```bash
cd backend
cp .env.example .env              # then set JWT_ACCESS_SECRET (see the comment in the file)
docker compose up -d              # PostGIS 16 + Redis
npm install
npx prisma migrate dev --name init   # creates the tables  (see "First migration" below)
SEED_ADMIN_PASSWORD='choose-a-strong-one' SEED_DEMO_PASSWORD='another-strong-one' npm run db:seed   # demo Dhaka restaurants + customer@/owner@foodflow.local + coupon WELCOME50
npm run dev                       # http://localhost:4000  (health: /health/live, realtime: /socket.io)
# To try the owner/admin side: sign in as owner@foodflow.local (demo owner) or the seeded admin.
```

### First migration
Shortcut: `DATABASE_URL=… ./scripts/create-init-migration.sh` does the steps below automatically (it could not be executed where this was written: see docs/DEPLOYMENT.md).

Manual steps:
Prisma cannot express PostGIS generated columns, partial unique indexes or CHECK constraints.
After `prisma migrate dev --name init` generates `prisma/migrations/<timestamp>_init/migration.sql`:

1. Open that file and **append the contents of `prisma/sql/001_postgis_and_constraints.sql`** to the end.
2. Run `npx prisma migrate reset --force` once so the combined migration is applied from scratch.
   From then on it ships with the migration history and `prisma migrate deploy` applies it in CI/production.

(Run it with `--create-only` first if you prefer to review: `npx prisma migrate dev --name init --create-only`, edit, then `npx prisma migrate dev`.)

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | watch mode (tsx) |
| `npm test` | unit + HTTP-wiring tests (no database required) |
| `TEST_DATABASE_URL=postgresql://… npm test` | additionally runs the SQL tests against a real PostGIS (discovery queries, constraint file). Uses a throw-away schema and cleans up |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build && npm start` | compile to `dist/` and run `node dist/server.js` |
| `npm run prisma:validate` | validate the schema |
| `npm run db:seed` | cuisines, platform settings, admin, demo restaurants (dev only) |

## Environment variables
Required: `DATABASE_URL`, `JWT_ACCESS_SECRET` (≥ 32 chars), `CORS_ORIGINS`, `APP_URL`. Rider document uploads require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` together. Configure a Cloudinary account and set these backend environment variables; the API issues short-lived signed uploads and stores verification images as authenticated assets. The app refuses to boot on invalid config, and in production requires `COOKIE_SECURE=true`.

## Third-party services
| Service | Used for | Phase |
|---|---|---|
| Google Maps Platform **or** Mapbox | geocoding, directions/ETA, map UI | 3, 6 |
| Cloudinary **or** S3-compatible storage | menu/restaurant images; rider verification uploads use signed, private Cloudinary storage | 4, 5 |
| Payment gateway (SSLCommerz / bKash / Nagad / Stripe): implement `PaymentProvider` | online payments (the interface, verified callbacks and a simulated gateway are done; no real adapter without credentials) | 7 |
| Email provider (SES/Resend/…) | password reset, receipts | 2 (adapter stub now) |
| Redis | rate-limit store, Socket.IO adapter, queues | 5-6 |

## Deployment
See **`docs/DEPLOYMENT.md`**: `Dockerfile` (targets `runtime` and `migrate`), `.github/workflows/ci.yml`, migration helper `scripts/create-init-migration.sh`, environment, cookie/domain setup, scaling limits and a pre-launch security checklist.

## Tests
```bash
npm test                                   # unit + HTTP wiring tests: no database needed (DB suites are skipped)
TEST_DATABASE_URL=postgresql://foodflow:foodflow@localhost:5432/foodflow npm test -- --runInBand
```
With `TEST_DATABASE_URL` set (a database where PostGIS can be created) the suite also runs, in a throw-away schema that it drops afterwards:
* **SQL contract tests**: the discovery/zone/sales queries and `prisma/sql/001_postgis_and_constraints.sql`, executed for real.
* **Real-socket tests**: a real Socket.IO server and clients (handshake security, notifications on commit, tracking rules/stale/ended, chat authorization incl. a replaced rider).
* **Integration tests** with the real services and Prisma: idempotent checkout under a double-click storm, overselling the last items, the last coupon use, cancel rollbacks, dispatch races, capacity, release/reassign, privacy by stage.
* **End-to-end**: the Express app over HTTP for customer, owner, rider and admin (register → approve → order → cook → dispatch → deliver), plus cookie/CSRF/session-reuse and rate-limit behaviour.
The integration schema is generated from `prisma/schema.prisma` by `test/support/schema-to-sql.ts` (a test fixture, not the production migration). Sessions run in a non-UTC time zone on purpose to catch timestamp bugs.
*Optional:* where Prisma's native engine cannot be downloaded, `scripts/make-wasm-test-client.sh` builds a WASM-engine client and `FF_WASM_CLIENT=$PWD/node_modules/.ff-wasm-client` makes the integration tests use it.

## Operational notes
* **Realtime scaling:** notifications work across instances (via Postgres); tracking/chat rooms are per instance until the Redis adapter is added (see `docs/REALTIME.md`). Run one realtime instance for now.
* **Run PostgreSQL in UTC.** Prisma stores timestamps as UTC in `timestamp(3)` columns; raw SQL in this project compares them in UTC explicitly, but database-side defaults (`CURRENT_TIMESTAMP`) follow the server time zone.
* The rate limiter is in-memory (fine for one instance); use `rate-limit-redis` before running several.
* Background jobs run inside the API process (`JOBS_ENABLED=true`); they are safe on multiple instances.
