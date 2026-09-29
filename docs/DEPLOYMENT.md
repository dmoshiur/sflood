# Deployment guide

FloodGrid deploys as a single Node service: Express serves the JSON API and the
built PWA from `dist/`. Migrations run on startup, so there is no separate
migration step to forget.

- [Local development](#local-development)
- [Production build](#production-build)
- [Deploying to Render](#deploying-to-render)
- [Using Turso instead of a local file](#using-turso-instead-of-a-local-file)
- [First super-admin](#first-super-admin)
- [Migrations, seeding and backups](#migrations-seeding-and-backups)
- [Post-deploy checklist](#post-deploy-checklist)
- [Operations](#operations)

## Local development

Requires Node.js 20.19 or newer.

```bash
npm install
cp .env.example .env      # optional: everything has a development fallback
npm run dev
```

- API on <http://localhost:3000>
- Vite dev server on <http://localhost:5173>, proxying `/api` to the API

Without `TURSO_DATABASE_URL` the app uses a local libSQL file at
`data/floodgrid.db`. Development secrets fall back to a generated value stored
in `data/.dev-secret-marker`; production refuses to start with a fallback.

Useful commands:

```bash
npm run db:migrate     # apply pending migrations
npm run db:seed        # create the labelled SIMULATION device (prints its key once)
npm test               # 106 tests: engine, security, pipeline, notifications, ops
npm run typecheck      # tsc for the server and the client
npm run build          # icons + typecheck + vite build
npm run backup         # copy the local database with a SHA-256 checksum
```

## Production build

```bash
npm ci
npm run build
npm start
```

`npm run build` regenerates the PWA icons, typechecks the server and the client,
and produces `dist/`. `npm start` runs `tsx server/index.ts`, which binds
`HOST:API_PORT` (or `PORT`), applies migrations, starts the notification worker,
the command expiry sweep and the ops-credential rotation timer, and then serves
`dist/` with an SPA fallback for every non-`/api` path.

Health endpoints:

| Path | Use |
| --- | --- |
| `/api/health/live` | Liveness: the process is up |
| `/api/health/ready` | Readiness: migrations applied and a query succeeds. **Use this one as the platform health check.** |
| `/api/health` | Status, version, database mode, table counts |
| `/api/health/detailed` | Health plus maintenance-mode flag |

## Deploying to Render

`render.yaml` in the repository root is a Render blueprint.

1. Push this branch to GitHub and create a new Blueprint instance in Render
   pointing at the repository. Render reads `render.yaml` and creates one web
   service.
2. In the dashboard, set every `sync: false` variable. The important ones:
   - `SETTINGS_ENCRYPTION_KEY` — 32 random bytes, hex or base64url. Encrypts
     SMTP/SMS credentials and TOTP secrets with AES-256-GCM. **Back it up.**
   - `OWNER_BOOTSTRAP_TOKEN` — 32+ random characters, used once.
   - `ADMIN_CIDR_ALLOWLIST`, `OPS_CIDR_ALLOWLIST`, `DEVICE_CIDR_ALLOWLIST` —
     comma-separated CIDRs. Admin and device routes fail closed when these are
     empty in production.
   - `OPS_SECURITY_EMAIL` — the mailbox that receives the rotating credential.
   - `PUBLIC_APP_URL` — your canonical HTTPS origin (the blueprint seeds it from
     `RENDER_EXTERNAL_URL`; replace it with a custom domain if you attach one).
3. Deploy. Render runs `npm ci && npm run build` then `npm start`. The service
   is not marked healthy until `/api/health/ready` returns 200.
4. Create the first super-admin (below), then remove `OWNER_BOOTSTRAP_TOKEN`
   from the environment.

`TRUST_PROXY=1` is set in the blueprint because one proxy hop (Render's edge)
sits in front of the app. If you put Cloudflare or another proxy in front,
increase it, or client-IP resolution — and therefore every CIDR allowlist —
will be wrong.

### Optional: persistent disk

If you are not using Turso, attach a disk and set:

```
LIBSQL_FILE=/data/floodgrid.db
```

Otherwise every deploy starts from an empty local database.

## Using Turso instead of a local file

1. Create a Turso database and copy its URL and an auth token.
2. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Nothing else changes: the
   same migrations, the same code, the same queries.
3. Keep `TURSO_AUTH_TOKEN` in the Render dashboard only.

Turso provides managed point-in-time backups; `npm run backup` records a backup
marker in that mode so the operations console and audit trail stay accurate.

## First super-admin

There is no default account, no default password and no seeded user.

```bash
curl -X POST https://your-host/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"displayName":"Owner","email":"owner@example.org","password":"…","token":"<OWNER_BOOTSTRAP_TOKEN>"}'
```

- The source IP must be inside `ADMIN_CIDR_ALLOWLIST`.
- The token must be at least 32 characters and match exactly.
- Bootstrap closes permanently once an `OWNER` row exists: a second call
  returns `409`.
- Enrol an authenticator app immediately after (`/app/profile`). Admin routes
  require a verified TOTP code.

Invite local admins and operators from **Admin → Invitations**; they accept
through `/accept-invite` and are scoped to a city and zone.

## Migrations, seeding and backups

Migrations live in `migrations/` as numbered SQL files and run on every start.
Already-applied migrations are skipped, so a redeploy is safe.

```bash
npm run db:migrate    # idempotent, safe on every deploy
npm run db:seed       # optional: the labelled SIMULATION device
npm run backup        # local mode: copies the DB and writes a .sha256 checksum
```

`npm run db:seed` creates exactly one device, flagged `simulation = 1`, and
prints its API key once. It creates no users, no fake telemetry and no fake
alerts. The key is stored only as a SHA-256 hash.

To start over locally:

```bash
npm run db:reset      # removes data/floodgrid.db*, migrates and seeds
```

## Post-deploy checklist

- [ ] `https://your-host/api/health/ready` returns `{"status":"ready"}`.
- [ ] `https://your-host/status` loads and shows either real telemetry or values
      explicitly labelled **SIMULATION**. There is no third option.
- [ ] The first super-admin exists, has MFA enrolled, and bootstrap now fails.
- [ ] Sign in as that owner, open `/hackeradmin`, and confirm the emailed
      credential plus TOTP works.
- [ ] Register and approve a device, or enable a simulation node.
- [ ] Enter SMTP settings in the admin console and send a test email.
- [ ] Confirm the audit log records the actions you just took.
- [ ] Confirm `.env` is git-ignored and no secret is in the repository.

## Operations

| Task | Where |
| --- | --- |
| Toggle a feature flag | `/hackeradmin` or `/admin` |
| Enable maintenance mode | `/admin` or `/hackeradmin` |
| Emergency stop a device | `/hackeradmin` → device emergency |
| Revoke a user session | `/hackeradmin` |
| Rotate the ops credential | Automatic every `OPS_ROTATION_MINUTES`, or manual from `/hackeradmin` |
| Review privileged actions | `/admin` → audit log |
| Back up the database | `npm run backup`, or Turso managed backups |
| Update flood thresholds | `/admin` → policies |
| Edit public pages | `/admin/pages` (schema-driven blocks, versioned, rollback) |

Logs to expect on a healthy start:

```
[floodgrid] applied migrations: 0001_initial, …
[floodgrid] database target: libsql (local file) | Turso (managed libSQL)
[floodgrid] FloodGrid API listening on http://0.0.0.0:3000
```

## Rollback

Render keeps previous deploys: promote the previous successful deploy from the
dashboard. Because migrations are additive and idempotent, rolling the code back
does not require rolling the schema back. If a migration must be reverted, do it
with a new forward migration rather than editing an applied one.
