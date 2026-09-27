# FloodGuard — Smart Flood Control & Automation

A bilingual science-fair concept for a tabletop, sensor-led flood barrier: ultrasonic water-level sensing → ESP32 state machine → servo model barrier + buzzer → dashboard and optional, consent-based notifications.

> **Educational prototype only. Not a real flood defense or emergency warning service.** This preview starts with fictional sample telemetry. No physical sensors, servos, public alerts, emergency dispatch, or production authentication are connected. Never rely on it to protect life or property.

Prepared for **Md Moshiur Rahman Mohi** · Sep 27, 2026.

## Run the full-stack preview

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open the Vite preview at [http://localhost:5173](http://localhost:5173). The Express API runs in the same repository on port 3000; Vite proxies relative `/api` requests to it. Browser-facing code never calls localhost directly. For a single-process production-style run:

```bash
npm run build
npm start
```

Express serves the built React/PWA site and API from one Node process. The local preview database is a generated, Git-ignored JSON file at `data/preview-store.json` (override with `DEMO_DATA_FILE`). Reset the sample network by deleting that local file and restarting.

Run checks with:

```bash
npm test
npm run build
```

## Product areas

- Public home and project brief with tray-model illustration, BOM/cost worksheet, safety notes and planned cloud architecture.
- `/app`: live *simulation* dashboard with 0–19 SAFE, 20–34 WATCH, 35–49 WARNING and 50+ CRITICAL thresholds, a trend chart, latched barrier state, event history, device cards and explicit demo controls.
- `/app/history`, `/devices`, `/devices/:id`, `/guides`, `/guides/:slug`, `/maintenance`, `/privacy`, `/terms`.
- `/login`, `/register` and `/hackeradmin` intentionally explain that authentication/OWNER access is **not enabled**. There are no default passwords, privileged demo credentials or admin writes.
- Installable PWA manifest and service worker. API telemetry is never cached as current data; the offline shell explicitly says readings are unavailable.
- `firmware/esp32-main` and `firmware/esp8266-sender` educational Arduino sketches. ESP8266 is sender-only. Example local configs contain placeholders; secrets are ignored.

The browser simulator mutates only local preview telemetry. The hardware telemetry endpoint is ingest-only; it has no barrier/motor command route. Real controller firmware must make safety decisions locally, even when Wi-Fi/cloud is unavailable.

## API

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/api/health` | API health and active storage mode. |
| `GET` | `/api/dashboard` | Dashboard snapshot, device summary, telemetry history and state-transition events for the configured dataset. |
| `GET` | `/api/history?limit=100` | Ordered telemetry history. |
| `GET` | `/api/devices`, `/api/devices/:id` | Device inventory and per-device readings. |
| `POST` | `/api/demo/simulate` | Local-preview actions: `rise`, `recede`, `sensor-fault`, `sensor-recovered`, `estop`, `estop-reset`, `reset`. Disabled when PostgreSQL is selected. |
| `POST` | `/api/v1/telemetry` | Authenticated device ingest; validates ranges, role-specific fields and monotonic sequence/replay. Never sends actuator commands. |
| `GET` | `/api/notifications/config` | Public integration availability and Web Push application key only. |
| `POST` / `DELETE` | `/api/notifications/push` | Save/remove a browser subscription after explicit user consent. |
| `POST` | `/api/notifications/email` | Save an email opt-in as pending and queue a confirmation when a mail provider is configured. |
| `GET` | `/api/notifications/verify`, `/api/notifications/unsubscribe` | Double-opt-in verification and unsubscribe links. |
| `GET` | `/api/firmware/releases` | Firmware release metadata (no binary is published in this preview). |
| `GET` | `/api/owner/status` | Reports that the protected Owner console is not available. |

Example sensor request (use HTTPS outside local development):

```http
POST /api/v1/telemetry
Authorization: Bearer <unique-device-key>
Content-Type: application/json

{
  "deviceId": "fg-esp32-01",
  "seq": 4822,
  "levelCm": 36.5,
  "sensorHealthy": true,
  "state": "WARNING",
  "barrierState": "RAISED",
  "emergencyStopActive": false
}
```

`state`, `barrierState`, and E-stop fields are optional for sender nodes. A sender cannot report actuator state. The API rejects state/level combinations outside the documented hysteresis bands and rejects duplicates/out-of-order sequence numbers.

## Optional PostgreSQL mode (deployment work)

The repository includes a PostgreSQL Prisma schema for tenants/cities/zones, users/roles/passkeys/sessions, devices, telemetry, idempotent commands, firmware releases, consented subscriptions, outbox events, content revisions and audit logs. Without `DATABASE_URL`, the app uses its local JSON simulation store. To configure Postgres:

1. Copy `.env.example` to `.env`; set a real `DATABASE_URL` and unique random `FG_ESP32_API_KEY` / `FG_ESP8266_API_KEY` values (32+ characters).
2. Generate the Prisma client, apply the schema, and seed the demo tenant:

   ```bash
   npm run db:generate
   npm run db:push
   npm run db:seed
   ```

3. Set `DEVICE_CIDR_ALLOWLIST` to the sensor gateway’s actual egress CIDR(s), configure `TRUST_PROXY` only for a known reverse proxy, then run `npm start`.

PostgreSQL mode disables the browser simulator. Device ingest is denied unless the source is in `DEVICE_CIDR_ALLOWLIST` and the per-device bearer token hash matches. No admin/CMS write endpoints are exposed.

## Notifications and optional providers

The outbox worker is in the API process. It deduplicates delivery keys and retries at 30 seconds, 2 minutes, 10 minutes and 30 minutes; after five attempts it dead-letters the event. Integrations require deployment secrets and consent:

- Web Push: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Email confirmation and verified email notifications: `RESEND_API_KEY`, `RESEND_FROM`, `PUBLIC_APP_URL`.
- SMS delivery: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
- Cloudinary media: package/schema preparation only; upload UI and signed upload authorization are not enabled in this demo.

When no provider is configured, notification requests remain pending or return a clear unavailable message; the app does not claim that an alert was delivered. No emergency service is connected.

## Current security boundary / not yet implemented

This build is a safe educational MVP, not the full production system described in the project brief. The Prisma schema captures the intended role/passkey/session/CMS/audit entities, and the Owner page is locked, but **member login/registration, invitations, passkey/MFA enrollment, CSRF sessions, OWNER bootstrap, CIDR-protected admin console, maintenance-mode writes and CMS preview/publish/rollback are not yet implemented**. Do not expose the admin or device ingest API to the public internet until those controls are implemented and independently reviewed.

The page brief's threshold values and wiring are starting assumptions. Recalibrate the HC-SR04 mounting zero, validate the real board pinout, Echo divider, servo torque/current, mechanical end stops and latching normally-closed E-stop with a supervisor. The tray model is not structurally representative of a river, surge, tide or coastal flood.
