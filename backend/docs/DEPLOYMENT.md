# Deployment

## Components
| Piece | Where | Notes |
|---|---|---|
| Frontend (Next.js) | Vercel | `NEXT_PUBLIC_API_URL` → the API's public URL |
| API (Express + Socket.IO) | any container host (Render, Railway, Fly.io, ECS…) | `Dockerfile` (target `runtime`); listens on `PORT` (default 4000); health: `GET /health/live`, `GET /health/ready` |
| PostgreSQL **with PostGIS** | managed (Neon, Supabase, RDS, Cloud SQL…) | run the server in **UTC**; the role needs `CREATE EXTENSION` once (or pre-create `postgis`) |
| Redis | managed | required before running **more than one** API instance (see "Scaling") |
| Object storage / Maps / Payments / Email | Cloudinary or S3 · Google Maps or Mapbox · payment provider · SES/Resend… | keys live only in the API's environment |

## First deploy
1. Create the database and set `DATABASE_URL`.
2. **Migrations.** First time only: `./scripts/create-init-migration.sh` (creates the init migration, appends the PostGIS/constraint SQL, applies it) and commit `prisma/migrations/`. From then on every release runs `npx prisma migrate deploy` (the Docker `migrate` target does exactly that).
3. Set the environment (see `.env.example`): `JWT_ACCESS_SECRET` (≥ 32 random chars), `CORS_ORIGINS` (exact frontend origin(s)), `APP_URL`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind a load balancer.
4. Seed reference data once: cuisines and platform settings. The seed also creates demo users and **refuses to run in production** by design; create the first admin with a one-off script/SQL instead.
5. Start the API. Probes: liveness `/health/live`, readiness `/health/ready` (checks the database).

## Cookies and domains
The refresh token is an httpOnly cookie scoped to `/api/v1/auth`. Preferred: same registrable domain (`app.example.com` + `api.example.com`) with `COOKIE_SAMESITE=lax`. Cross-site (e.g. `*.vercel.app` + a separate API domain) needs `COOKIE_SAMESITE=none` + `COOKIE_SECURE=true`; the CSRF header/origin checks on `/auth/refresh` and `/auth/logout` already assume this.

## Scaling and known limits
* **Realtime:** notifications fan out through Postgres `LISTEN/NOTIFY`, so they work across instances. Tracking and chat rooms are **per instance** until the Socket.IO Redis adapter is added: run **one** API instance (or sticky routing with all of an order's participants on it) until then.
* **Rate limiting** is in-memory per instance: switch to `rate-limit-redis` with the same change.
* **Background jobs** (dispatch sweep, accept-timeout, retention purges) run inside the API process. They are safe on several instances (row locks + state re-checks).
* **Retention:** rider trail points are purged after `LOCATION_RETENTION_HOURS`; finished chats after `chat.retentionDays` (platform setting).

## Security checklist before launch
- [ ] `JWT_ACCESS_SECRET` generated per environment, never committed; rotate on suspicion of leak
- [ ] `COOKIE_SECURE=true`, exact `CORS_ORIGINS`, HTTPS everywhere
- [ ] Database role is least-privilege (no superuser; `CREATE EXTENSION postgis` done by an admin once)
- [ ] Real email provider wired into `src/mail` (the shipped adapter only logs reset links in development)
- [ ] Real payment provider adapter + webhook secret (the shipped provider is the development adapter)
- [ ] Image upload goes through signed URLs; `IMAGE_HOST_ALLOWLIST` set
- [ ] Backups and point-in-time recovery enabled on the database; restore tested
- [ ] `npm audit --omit=dev` clean (CI enforces high severity)

## Not verified in this repository's sandbox
The `Dockerfile` and the GitHub Actions workflow were written but **not executed** (no Docker daemon or CI runner was available), and `scripts/create-init-migration.sh` could not run because Prisma's migration engine cannot be downloaded there. The CI workflow is built to exercise all three on its first run: treat that run as their test.
