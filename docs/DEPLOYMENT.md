# Deploying FloodGuard

## Render

A ready `render.yaml` blueprint is included at the repository root. It declares:

- `floodguard-db` — a Turso connection is configured separately (see below).
- `floodguard-api` — Node web service: `npm ci && npm run build` then `npm start`, health check `/api/health`.

Steps:

1. Fork/push this repository to GitHub and create a new Blueprint instance from `render.yaml`.
2. Provision a Turso database (`turso db create floodguard`), grab the URL and token (`turso db show`, `turso db tokens create`).
3. In the Render service environment set: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`, `OWNER_BOOTSTRAP_TOKEN`, `ADMIN_CIDR_ALLOWLIST`, `DEVICE_CIDR_ALLOWLIST`, `OPS_SECURITY_EMAIL`, `PUBLIC_APP_URL`, `SESSION_COOKIE_SECURE=1`, `TRUST_PROXY=1`. Optional: `VAPID_*`, `IPINFO_TOKEN`, `VITE_FIRMWARE_*` links.
4. First deploy, then run migrations (one-off shell or local against the production DB):

   ```bash
   npm run db:migrate
   npm run db:seed    # development/reference data only — skip for production
   ```

5. Create the first owner: `POST /api/auth/bootstrap` with `OWNER_BOOTSTRAP_TOKEN` from an allowed CIDR (see README).

## Environment variables

See `.env.example` for the full annotated list. Highlights:

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Turso/libSQL connection; empty URL runs the labeled local simulation |
| `SETTINGS_ENCRYPTION_KEY` | AES-256-GCM key for SMTP/SMS/TOTP secrets at rest |
| `SESSION_SECRET` | HMAC key for verification/unsubscribe tokens |
| `OPS_SECURITY_EMAIL` | Inbox for the hourly rotating operations code |
| `ADMIN_CIDR_ALLOWLIST` / `DEVICE_CIDR_ALLOWLIST` | Fail-closed CIDR gates for admin and device surfaces in production |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push |
| `VITE_FIRMWARE_ESP32_URL`, `VITE_FIRMWARE_ESP8266_URL`, `VITE_FIRMWARE_GITHUB_RELEASES_URL`, `VITE_FIRMWARE_GITHUB_REPO_URL` | Your own firmware/GitHub links shown on `/devices` (unset → the page says "not configured") |

## Production checklist

- [ ] All security checklist items in [SECURITY.md](SECURITY.md)
- [ ] `npm run build && npm test` green in CI
- [ ] Migrations applied (`npm run db:migrate`)
- [ ] SMTP/SMS/Web Push providers configured and test-sent; delivery statuses visible in the owner console
- [ ] Service areas match the deployment scope; registration tested from an allowed and a blocked city
- [ ] Device provisioning flow tested end-to-end (token → QR → flash → telemetry → command ack)
- [ ] Backup/restore rehearsed for Turso; `SETTINGS_ENCRYPTION_KEY` backed up
- [ ] Firmware links on `/devices` point at your own releases
- [ ] Prototype disclaimer visible on the public pages

## Simulation mode

With an empty `TURSO_DATABASE_URL` the API runs the local JSON store and the UI displays **SIMULATION** badges plus the "Generated demonstration feed" caption. Simulation mode never claims to be live — treat it strictly as a development tool.
