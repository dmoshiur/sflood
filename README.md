# FloodGuard — Smart Flood Control & Automation

FloodGuard is a bilingual science-fair concept for a tabletop flood-control model: ultrasonic water-level sensing → ESP32/ESP8266 sensor nodes → a five-state flood engine → servo model perimeter barrier and buzzer → a bilingual web command center with live status, notifications, an owner console and a rotating-key operations console.

> **Educational prototype only. Not a real flood defense or emergency warning service.** Never rely on FloodGuard to protect people or property. The platform is designed to be honest about what is real and what is simulated: every live value comes from the device API or the database, and anything generated for demonstration is labeled **SIMULATION** in the UI.

Prepared for **Md Moshiur Rahman Mohi** · Sep 27, 2026.

## What the platform includes

- **Five-state flood engine** (`NORMAL`, `WATCH`, `WARNING`, `CRITICAL`, `RECOVERY`) with absolute thresholds, rate-of-rise escalation, hysteresis, recovery cooldown, state-transition cooldown, duplicate-event prevention and optional multi-sensor confirmation. Every transition persists a flood event, fans out notifications, can raise the barrier (policy-controlled) and writes audit records.
- **Device platform**: registered devices with unique IDs, approval workflow, per-device API keys (hashes at rest), sequence-number replay protection, telemetry with level/rate/actuator/limit-switch/RSSI/uptime/firmware/fault fields, heartbeats, device health, remote config, firmware-version reporting and a **remote barrier command channel** with command ID + nonce + 120-second expiry + single acknowledgement + limit-switch feedback and local fail-safe arbitration. No master backend secret ever ships in firmware.
- **Public experience**: bilingual landing page, live `/status` (state, water level, trend, barrier state, safety instructions, event timeline), double opt-in email subscription, installable PWA shell.
- **User experience**: registration restricted by a **service-area allowlist** (IP geolocation is advisory only), email verification, login/logout, profile editing, Cloudinary avatar upload, notification preferences, browser push, in-app notification inbox.
- **`/app` dashboard**: live values from the API, labeled simulation walk-through, event history, guided pages.
- **`/hackeradmin`** (dark navy + gold): device approval/revocation/key rotation/provisioning/commands, flood-engine threshold & policy editors with presets, drag-and-drop schema-driven site content editor (preview, draft, publish, versioning, rollback — no executable JS), service-area management, maintenance mode, emergency site status, provider gateways, super-admin management, audit trail and a **rotating operations console** (server-minted 12-character code every hour, delivered by email, stored hashed, rate-limited, auto-expiring; TOTP admin MFA included).
- **Notification provider abstraction**: SMTP email, Twilio-compatible SMS and Web Push with outbox queues, retries, per-recipient delivery status, provider message IDs and failure reasons — telemetry ingestion is never blocked by notification delivery.

## Run the integrated app

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open the Vite site at [http://localhost:5173](http://localhost:5173). The Express API runs on port 3000, and Vite proxies relative `/api` calls to it. Browser code never hard-codes hostnames.

Without `TURSO_DATABASE_URL`, the API runs an explicitly labeled local simulation backed by the Git-ignored `data/preview-store.json`. With Turso configured, every value is real: run `npm run db:migrate && npm run db:seed` first.

```bash
npm run build   # server + client typecheck, then the production bundle
npm start       # single-process server of dist/
npm test        # 20 tests: engine, security, auth, providers, ops, commands, device API, service areas
```

## Route map

| Route | Purpose |
| --- | --- |
| `/` | Bilingual landing page |
| `/status` | Public live status board (state, level, trend, barrier, safety instructions, subscribe) |
| `/devices` | Firmware downloads (env-configured links), flashing + wiring guides, provisioning flow |
| `/alerts`, `/profile`, `/login`, `/register` | Account area (inbox, profile/push, sign in, service-area registration) |
| `/app`, `/app/history` | Dashboard + event history (simulation walk-through is labeled) |
| `/guides`, `/about`, `/project` | Guides, project brief, policy pages |
| `/hackeradmin` | Owner/ops console (role-gated; operations tab needs the rotating ops code) |

APIs: `/api/health`, `/api/public/*`, `/api/v1/*` (device facing), `/api/auth/*`, `/api/profile/*`, `/api/owner/*`, `/api/ops/*`. Full reference: [docs/API.md](docs/API.md).

## Hardware and firmware

- `firmware/esp32-main` — model controller: sensor + servo barrier + buzzer + E-stop + limit switches, local fail-safe state machine (`NORMAL`→`WATCH`→`WARNING`→`CRITICAL`, receding through `RECOVERY`), telemetry and the remote command channel with nonce acknowledgement. See [docs/DEVICE_SETUP.md](docs/DEVICE_SETUP.md) and [docs/WIRING.md](docs/WIRING.md).
- `firmware/esp8266-sender` — telemetry-only node; it has no actuator and the server refuses barrier commands for it.
- Both sketches exchange a **one-time provisioning token** (admin console QR code) for a per-device API key and pin HTTPS with a locally pasted root CA. Example configs contain placeholders only; `config.h` is Git-ignored. The environment-configurable firmware/GitHub links on `/devices` are **unset by default** — fill in `VITE_FIRMWARE_*` in `.env` with your own URLs.

## Security model (summary)

See [docs/SECURITY.md](docs/SECURITY.md) for the full write-up. Highlights: server-side RBAC on every privileged route, per-device API keys stored as hashes, telemetry sequence replay rejection, command nonce replay protection, hourly rotating operations credential (hash at rest, email delivery, rate-limited attempts, automatic expiry), TOTP admin MFA, AES-256-GCM encryption of provider secrets, CIDR allowlists for admin/device surfaces (fail closed in production), and audit logging of every critical action.

## Documentation

- [docs/API.md](docs/API.md) — endpoint reference
- [docs/DEVICE_SETUP.md](docs/DEVICE_SETUP.md) — flashing, provisioning and firmware update metadata
- [docs/WIRING.md](docs/WIRING.md) — wiring tables and safety notes
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and controls
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Render deployment and production checklist

## Prototype disclaimer

This project is a demonstration of a full-stack IoT automation pipeline built for a science-fair exhibit. Flood modeling is simplified to a single water level; thresholds are configurable but do not constitute engineering advice; the model barrier is a lightweight servo. Do not deploy in place of certified flood monitoring or emergency systems.
