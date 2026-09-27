# FloodGuard — Smart Flood Control & Automation

FloodGuard is a bilingual science-fair concept for a tabletop flood-control model: ultrasonic water-level sensing → an ESP32 state machine → servo model barrier and buzzer → dashboard and optional, consent-based project updates.

> **Educational prototype only. Not a real flood defense or emergency warning service.** The default preview uses fictional local data. Cloud credentials, real devices, emergency dispatch and message providers are not included. Never rely on FloodGuard to protect people or property.

Prepared for **Md Moshiur Rahman Mohi** · Sep 27, 2026.

## Run the integrated app

Requires Node.js 20.19 or newer.

```bash
npm install
npm run dev
```

Open the Vite site at [http://localhost:5173](http://localhost:5173). The Express API runs in this repository on port 3000, and Vite proxies relative `/api` calls to it. Browser code does not call `localhost` directly.

Without `TURSO_DATABASE_URL`, the API runs an explicitly labeled local simulation backed by the Git-ignored `data/preview-store.json`. It is for exploring the UI only; it is not the Turso backend. For a built, single-process run:

```bash
npm run build
npm start
```

Run automated checks with:

```bash
npm test
npm run build
```

The test suite includes local libSQL migration and notification-eligibility tests; it does not need live Turso or SMS/SMTP credentials.

## Product areas

- Public bilingual overview, project brief, detailed custom mark, illustrative tray model, safety notes and build guides.
- `/app`: simulation dashboard with SAFE/WATCH/WARNING/CRITICAL sample bands, trends, event history, device cards and consent controls. `/app/history`, `/devices`, `/guides` and project-policy pages provide supporting views.
- `/hackeradmin`: protected super-admin control plane. `/login` is for existing accounts; `/register` accepts a one-time super-admin invitation only. There is no public registration, default password or demo owner account.
- `firmware/esp32-main` and `firmware/esp8266-sender`: educational sketches. The sender is telemetry-only. Example board configs contain placeholders; real secrets are not committed.
- Installable PWA shell. Telemetry is not cached as current data while offline.

The browser simulator only changes local demo telemetry. The device API accepts validated telemetry and exposes **no** actuator-command route. Any real controller must make safety decisions locally, independent of Wi-Fi or cloud access.

## Turso deployment and first super-admin

1. Create a Turso/libSQL database and copy `.env.example` to `.env`. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
2. Generate and securely set:
   - `SETTINGS_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hex characters (or base64). This encrypts SMTP/SMS settings and TOTP secrets with AES-256-GCM. **Back it up securely and keep it stable**; losing it makes stored settings unreadable.
   - `SESSION_SECRET`: at least 32 random characters. It keys SMS verification-code hashes and stable SMS unsubscribe tokens; keep it private and stable.
   - `OWNER_BOOTSTRAP_TOKEN`: at least 32 random characters. This is a one-time, out-of-band bootstrap credential, not an owner password.
   - Two different, random `FG_ESP32_API_KEY` and `FG_ESP8266_API_KEY` values, each at least 32 characters.
3. Set `PUBLIC_APP_URL` to the canonical public HTTPS origin. Configure `ADMIN_CIDR_ALLOWLIST` for the trusted super-admin source IP(s), and `DEVICE_CIDR_ALLOWLIST` for the sensor gateway egress range(s). `OWNER_BOOTSTRAP_CIDR_ALLOWLIST` can further restrict the first bootstrap; if omitted, bootstrap falls back to the admin allowlist. Production admin and device CIDR lists fail closed when empty.
4. Run migrations and create the sample tenant/device records:

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   The API also applies pending SQL migrations automatically at startup. The seed is explicit and requires the two device API keys. It creates demo tenant/device/sample telemetry records, but no users or provider settings.
5. Visit `/hackeradmin` from an allowlisted source IP and enter the one-time bootstrap token to create the first super-admin. Bootstrap permanently closes once an `OWNER` record exists. Enroll an authenticator app before using provider or account controls.
6. Preserve `SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`, database access and owner recovery access in a secure secret manager. Never paste live credentials into source control or the frontend.

`/hackeradmin` is unavailable in local simulation mode. In Turso mode, elevated owner actions require a database-backed session, CSRF validation, authenticator MFA and the admin CIDR allowlist. Sessions use random opaque tokens in HttpOnly, SameSite=Strict cookies and expire after four hours for privileged users. Passwords are scrypt-hashed; bootstrap is protected by a rate limit and timing-safe token comparison. The super-admin console can invite another super-admin, disable or re-enable accounts, reset another owner's MFA (revoking their sessions), review the audit trail, and configure providers.

## SMTP and SMS gateway setup

Provider credentials are entered manually in the protected `/hackeradmin` **Provider gateways** panel. The server encrypts saved SMTP passwords and SMS API tokens before writing them to Turso. Secret values are never returned by provider APIs; the browser only receives configured/has-secret indicators. Keep the encryption key server-side.

- **SMTP:** configure host, port/TLS, optional username/password, sender and reply-to. The verify action tests a connection; providing a recipient sends a real test email.
- **SMS HTTP:** configure a public HTTPS JSON endpoint, authorization header/prefix, API token, sender ID and JSON field names. The explicit test action sends a real, potentially billable SMS. The gateway must accept a JSON request with the configured recipient and message fields.
- SMTP/SMS provider settings are global to this single-tenant control plane. Configure and test with accounts and destinations you control. Real delivery cannot be demonstrated until valid provider credentials are supplied.

Optional project updates require explicit consent. Email uses double opt-in and expiring confirmation links. SMS uses a one-time verification code sent directly through the configured gateway; this verification message is not an alert and is not placed in the alert outbox. SMS alert recipients are queued **only when both `phone` and `phone_verified_at` are present**. SMS messages include a signed unsubscribe link. Web Push requires VAPID keys. `PUBLIC_APP_URL` and a strong `SESSION_SECRET` are required for safe email/SMS opt-in links and SMS code storage.

The Turso outbox deduplicates delivery keys, claims work with a short recovery lease, retries failures with bounded backoff, clears sensitive message payloads after success/dead-letter and records permanent failures. Outbox delivery does not mean a carrier or mail provider delivered a message; check provider delivery reports.

## Configuration reference

See `.env.example` for all supported variables. Key settings:

| Variable | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | libSQL/Turso connection. |
| `SETTINGS_ENCRYPTION_KEY` | AES-256-GCM key for encrypted provider/TOTP settings. |
| `SESSION_SECRET` | HMAC key for SMS code and unsubscribe tokens. |
| `OWNER_BOOTSTRAP_TOKEN` | One-time first-owner bootstrap secret. |
| `ADMIN_CIDR_ALLOWLIST`, `OWNER_BOOTSTRAP_CIDR_ALLOWLIST` | Restrict privileged management and initial owner creation. |
| `DEVICE_CIDR_ALLOWLIST` | Restrict device telemetry ingress in Turso mode. |
| `FG_ESP32_API_KEY`, `FG_ESP8266_API_KEY` | Distinct device keys; only SHA-256 hashes are stored in the seed database. |
| `PUBLIC_APP_URL` | Canonical public HTTPS origin used in confirmation/unsubscribe links. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional Web Push configuration. |
| `TRUST_PROXY` | Set only for a known, trusted reverse-proxy hop count. |

SMTP and SMS secrets are configured in Hackeradmin, not in `.env`.

## API overview

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | API health and active mode. |
| `GET` | `/api/dashboard`, `/api/history`, `/api/devices`, `/api/devices/:id` | Dashboard and telemetry views. |
| `POST` | `/api/demo/simulate` | Local-only simulator controls; disabled in Turso mode. |
| `POST` | `/api/v1/telemetry` | Device-key-authenticated, CIDR-restricted, replay-checked telemetry ingest. No actuator commands. |
| `GET` | `/api/auth/status`, `/api/auth/me` | Bootstrap availability and current session state. |
| `POST` | `/api/auth/bootstrap`, `/api/auth/login`, `/api/auth/accept-invite`, `/api/auth/logout` | First owner creation, account sign-in, invitation acceptance and sign-out. |
| `POST` | `/api/auth/totp/start`, `/api/auth/totp/confirm` | Privileged-account TOTP enrollment. |
| `GET` / `PUT` / `POST` | `/api/owner/providers/*` | Owner-only encrypted provider summaries, updates and SMTP/SMS tests; protected by session, MFA, CIDR and CSRF checks. |
| `GET` / `POST` / `PATCH` | `/api/owner/users*`, `/api/owner/audit` | Super-admin account/invitation management, MFA reset and audit data. |
| `GET` | `/api/notifications/config` | Public integration availability and Web Push public key only. |
| `POST` / `DELETE` | `/api/notifications/push` | Save/remove a browser push subscription after explicit consent. |
| `POST` | `/api/notifications/email` | Save pending email consent and queue a confirmation when SMTP is configured. |
| `POST` | `/api/notifications/sms`, `/api/notifications/sms/verify` | Send and verify an optional SMS opt-in code. |
| `GET` | `/api/notifications/verify`, `/api/notifications/unsubscribe` | Confirm email or revoke optional project updates. |
| `GET` | `/api/firmware/releases` | Demo release metadata; no firmware binary is published. |

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

Sender-only nodes cannot report actuator or E-stop state. State/level combinations outside the documented hysteresis bands and duplicate/out-of-order sequence numbers are rejected.

## Safety boundary

This is an educational software and tray-model prototype. It does not provide real flood protection, evacuation decisions, emergency dispatch or certified warnings. Values in the local preview are fictional. Even with Turso/provider configuration, this code is not a safety-rated system and does not operate real hardware. Do not expose a physical barrier to public routes or rely on a dashboard for life-safety decisions.

A physical classroom model still needs shallow contained water, low-voltage power, a correctly rated servo supply, guarded moving parts, mechanical end stops, a normally-closed latching E-stop and supervised testing. Recalibrate the HC-SR04 mounting zero and verify the exact board pinout and Echo divider. The tray model is not structurally representative of a river, surge, tide or coastal flood.
