# FloodGrid — Smart Flood Control & Automation

A full-stack, multi-tenant IoT platform for a raised miniature city: ultrasonic
water-level sensing, a real-time flood decision engine, an automated perimeter
barrier, notification fan-out across email/SMS/push/in-app, a device registry
with signed provisioning, and two admin consoles.

> **Educational prototype only. Not a real flood defence or emergency warning
> service.** FloodGrid is a science-fair project. It must never be relied on to
> protect people or property, and it must never be connected to real flood
> infrastructure.

Prepared for **Md Moshiur Rahman Mohi** · September 2026.

## What is in the box

| Area | What it does |
| --- | --- |
| **Flood engine** | Five states (`NORMAL` → `WATCH` → `WARNING` → `CRITICAL`, plus a latched `RECOVERY`) from calibrated thresholds, rate of rise, hysteresis, a recovery latch, a cooldown window, duplicate-event prevention and multi-sensor confirmation. Pure and deterministic in `shared/flood-engine.ts`. |
| **Device registry** | Per-device UID, one-time provisioning token with a QR code, per-device API keys stored only as SHA-256 hashes, rotation, revocation, approval workflow, health and heartbeat. |
| **Barrier control** | Commands carry a unique id, a single-use nonce and a 120 s expiry. Devices poll, execute locally and acknowledge idempotently. The controller, not the cloud, makes the final safety decision. |
| **Notifications** | Provider abstraction over EMAIL (SMTP), SMS (HTTP gateway), WEB_PUSH (VAPID) and IN_APP, with a durable queue, retries with backoff, provider message ids, failure reasons, retry counts and dead-lettering. Ingestion never waits on delivery. |
| **Accounts** | Register/login/logout inside a service-area allowlist, email verification, password reset and change, TOTP enrolment, sessions, invitations, four roles (`MEMBER`, `OPERATOR`, `ADMIN` scoped to a city/zone, `OWNER`). |
| **Public site** | Landing page, live `/status` page, verified double opt-in email subscription, PWA install with offline shell, generated icons, service worker and push handler. |
| **Admin console** | Users, invitations, service areas, flood policies, subscribers, templates, site settings, feature flags, maintenance mode, provider credentials (AES-256-GCM at rest), alerts, reports and the audit log. |
| **Site builder** | Schema-driven drag-and-drop pages from a validated block library, with draft/published versioning, rollback and preview. Stored pages contain no arbitrary HTML or JavaScript. |
| **Ops console** (`/hackeradmin`) | Dark-navy/gold control plane. A rotating credential is emailed, stored only as a hash, single-use, rate-limited, short lived and paired with TOTP. |
| **Simulation** | A labelled simulation node that writes to the same tables as real telemetry with `simulated = 1` flags. |

**No mock data.** Every number on every dashboard comes from the database or
from a device API call. The single exception is the simulation node, and every
value it produces is labelled **SIMULATION** in the UI and flagged
`simulated: true` in the API.

## Quick start

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

- API: <http://localhost:3000>
- App: <http://localhost:5173> (Vite proxies `/api` to the API)

```bash
npm run db:migrate    # apply migrations
npm run db:seed       # create the labelled SIMULATION device (prints its key once)
npm test              # 106 tests
npm run build         # icons + typecheck + production bundle
npm start             # serve the API and the built PWA from one process
```

## Create the first super-admin

There is no default account. Create the first `OWNER` once, out of band:

```bash
# .env
OWNER_BOOTSTRAP_TOKEN=<32+ random characters>
ADMIN_CIDR_ALLOWLIST=<your ip/cidr>
```

```bash
curl -X POST localhost:3000/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"displayName":"Owner","email":"owner@example.org","password":"…","token":"…"}'
```

Bootstrap closes permanently once an owner exists. Enrol an authenticator app
right afterwards; admin routes require a verified TOTP code.

## Connect a device

1. **Devices** → register a board (name, board, zone). The console returns a UID,
   a one-time provisioning token and a QR code.
2. Approve the device.
3. Copy `firmware/esp32-main/config.example.h` to `config.h`, fill in Wi-Fi, the
   API URL and the token, then flash.
4. The board calls `POST /api/v1/provision` once, stores its API key in flash and
   starts reporting telemetry, polling for commands and sending heartbeats.

`firmware/esp32-main` is the controller (sensing, local state machine, servo
barrier, limit switches, emergency stop). `firmware/esp8266-sender` is a
telemetry-only second sensor. Neither contains a secret, and no repository URL
is hard-coded: firmware links come from `FIRMWARE_GITHUB_*` environment
variables.

Full walkthrough: [`docs/DEVICE_SETUP.md`](docs/DEVICE_SETUP.md) ·
Wiring and calibration: [`docs/WIRING.md`](docs/WIRING.md) ·
HTTP contract: [`docs/API.md`](docs/API.md).

## Configuration

Copy `.env.example` to `.env`. Everything has a development fallback except in
production, where missing secrets refuse to start.

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session and one-time token key (32+ chars) |
| `SETTINGS_ENCRYPTION_KEY` | AES-256-GCM key for provider credentials and TOTP secrets |
| `PUBLIC_APP_URL` | Canonical HTTPS origin used in every emailed link |
| `OWNER_BOOTSTRAP_TOKEN` | One-time bootstrap credential (32+ chars) |
| `ADMIN_CIDR_ALLOWLIST` / `OPS_CIDR_ALLOWLIST` / `DEVICE_CIDR_ALLOWLIST` | Source CIDRs; admin and device routes fail closed when empty in production |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Hosted libSQL; empty means the local file in `data/` |
| `OPS_SECURITY_EMAIL` | Mailbox that receives the rotating ops credential |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push |
| `CLOUDINARY_*` | Signed avatar uploads (secret never leaves the server) |
| `FIRMWARE_GITHUB_*` | Download links shown in the app; empty hides them |

SMTP and SMS credentials are **not** environment variables: they are entered in
the admin console and encrypted at rest. See
[`docs/SECURITY.md`](docs/SECURITY.md) for the full model.

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/API.md`](docs/API.md) | Every endpoint, request and response shape, status codes, rate limits |
| [`docs/DEVICE_SETUP.md`](docs/DEVICE_SETUP.md) | Register → approve → provision → flash → verify, plus troubleshooting |
| [`docs/WIRING.md`](docs/WIRING.md) | Pin map, power rails, echo divider, safety chain, calibration |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, secret handling, roles, allowlists, audit, limitations |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Local, Render, Turso, migrations, backups, rollback, checklist |

## Deploying

`render.yaml` is a Render blueprint: one web service, `npm ci && npm run build`
then `npm start`, health-checked on `/api/health/ready`. Migrations run at
startup. Details, including the Turso option and a post-deploy checklist, are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Testing

```bash
npm test              # node:test runner, no network or provider needed
npm run typecheck     # tsc --noEmit for server and client
npm run build         # icons + typecheck + vite build
```

106 tests cover the flood engine, password hashing and policy, the service-area
allowlist, device authentication and provisioning, replay protection, the
telemetry → policy → event → command → notification pipeline, barrier command
authorisation and idempotency, the notification queue and fan-out, the rotating
ops credential and the site-builder content schema. Each test file runs against
its own libSQL file created from the real migrations — nothing is mocked.

## Project layout

```
migrations/           0001–0013 SQL schema and reference data
server/               Express API: config, database, security, rbac, auth,
                     devices, commands, telemetry, notifications, routes/
shared/               Pure flood engine and site-block schemas
src/                   React 19 + React Router PWA (pages, components, api client)
public/                Manifest, service worker, generated PNG icons
firmware/              ESP32 controller and ESP8266 sender sketches
scripts/               migrate, seed, backup, icon generation
docs/                  API, device setup, wiring, security, deployment
```

## Prototype limitations

- The firmware sketch disables TLS certificate validation so it can run against
  a self-signed local deployment. Pin the API root CA for any real use.
- The barrier is a model servo, not a flood gate, and the emergency stop is a
  prototype-grade safety chain.
- There is no WAF, IDS or SIEM integration.
- Simulation is the only source of non-device data, and it is always labelled.

## Safety notice

FloodGrid exists to demonstrate full-stack engineering: a typed API, a real
decision engine, auditable privileged actions, encrypted secrets at rest,
provisioned hardware and honest data. If water is rising where you are, follow
the instructions of your local emergency authority. Never use this project for
a life-safety decision.
