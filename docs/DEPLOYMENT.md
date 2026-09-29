# Production deployment

FloodGuard is an educational prototype. A successful deployment does not make it suitable for life-safety or flood-defense use. Do not deploy it as a substitute for certified monitoring, alarms, or emergency systems.

## Requirements

- Node.js 20.19 or newer.
- A provisioned Turso/libSQL database and server-side `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`.
- HTTPS at the public edge, secure cookies, and a reverse proxy configuration that matches the deployment platform.
- Independent secrets and narrowly scoped network allowlists.

Without Turso, database-backed API operations fail closed. Do not expect local JSON storage, generated readings, or a demo data mode.

## Render blueprint

The repository includes `render.yaml` for a Node web service. It runs `npm ci && npm run build`, starts with `npm start`, and uses `/api/health` as its liveness check. Turso is provisioned separately.

1. Deploy the repository's Render blueprint in the intended account and region.
2. Create a Turso database in the intended environment and set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the service's secret environment.
3. Configure all required secrets and network policies listed below before enabling account or device traffic.
4. Apply schema migrations using a controlled release step or an approved operator environment:

   ```bash
   npm ci
   npm run db:migrate
   ```

   Then run `npm run db:seed` once for this database. It creates only the initial tenant/project/city/zone metadata required by owner bootstrap and onboarding; it does not create users, devices, or readings. Review and update these metadata records and the seeded service-area allowlist before opening registration.
5. Verify `/api/health/ready` reports database readiness and inspect application logs. Liveness alone does not establish database readiness.
6. Bootstrap the first owner using the protected `/api/auth/bootstrap` route from an allowed source. Store the bootstrap token securely and rotate/remove its access after setup as the implementation permits.
7. Enroll a test device in a controlled, non-life-safety environment. Verify the complete flow: approval, one-time provisioning, authenticated telemetry, stored readings, queued command, and device acknowledgement. Confirm the physical controller's local fail-safe behavior independently.

## Configuration

See [.env.example](../.env.example) for the current annotated list. Key settings:

| Variable | Use |
| --- | --- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Server-side database connection. Never expose these to the browser or firmware. |
| `SETTINGS_ENCRYPTION_KEY` | Encrypts stored sensitive integration settings. Back it up securely; loss may make encrypted values unreadable. |
| `SESSION_SECRET` | Signs security tokens. Generate independently from all other secrets. |
| `OWNER_BOOTSTRAP_TOKEN` | Initial owner bootstrap secret. Do not use as a normal account credential. |
| `ADMIN_CIDR_ALLOWLIST` | Trusted source CIDRs for privileged admin operations. Review reverse-proxy address handling before setting this. |
| `DEVICE_CIDR_ALLOWLIST` | Trusted device/gateway source CIDRs in production. Keep it narrow. |
| `PUBLIC_APP_URL` | Canonical public HTTPS origin used by generated links. |
| `SESSION_COOKIE_SECURE`, `TRUST_PROXY` | Configure secure cookies and trusted proxy behavior for the deployment topology. Trust only proxies under your control. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional web push integration. |
| `OPS_SECURITY_EMAIL` | Destination for configured rotating-operations access delivery. |
| `VITE_FIRMWARE_*` | Optional public firmware/release links; set only to reviewed, controlled artifacts. |

SMTP/SMS credentials are entered through protected server-side administration where supported. Keep all credentials out of client bundles, logs, firmware, and repository history.

## Release and operational checks

- [ ] Build and automated tests pass for the exact release commit.
- [ ] Production migrations are applied and database readiness is confirmed.
- [ ] Backups and restoration have been tested; encryption-key recovery is documented.
- [ ] TLS, cookie, CORS/origin, proxy, and CIDR configuration has been reviewed for the actual topology.
- [ ] Owner bootstrap is complete and the bootstrap secret is protected/rotated.
- [ ] Device approval, provisioning, telemetry persistence, command acknowledgement, and revocation have been tested using non-critical hardware.
- [ ] Notification integrations have been explicitly configured and delivery tested if they are used.
- [ ] Logs/alerts are monitored without recording credentials or provisioning tokens.
- [ ] Safety disclaimers remain visible and all physical fail-safes are tested independently.

Automated tests and a healthy HTTP response are not evidence that a live Turso account, provider integration, device, actuator, backup, or production deployment has been verified. Record such verification separately and only after it has actually occurred.
