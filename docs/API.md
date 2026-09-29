# FloodGrid API reference

Base URL: your deployment origin, e.g. `https://floodgrid.example.org`.
All API paths are prefixed with `/api`. In development the Vite dev server
proxies `/api` to the Express process on port 3000, so browser code always uses
relative URLs.

Every response is JSON. Errors use the shape `{ "error": "message" }` and a
conventional status code.

| Status | Meaning |
| --- | --- |
| 200 / 201 / 202 | Success |
| 400 | Validation failed (zod schema) |
| 401 | Not authenticated, or a device key is invalid |
| 403 | Authenticated but not allowed (role, scope, CIDR allowlist) |
| 404 | Route or record not found |
| 409 | Duplicate, conflicting or replayed request |
| 429 | Rate limited |
| 503 | Database not ready, or the client bundle has not been built |

## Conventions

- **Authentication (humans)**: an http-only session cookie. The browser also
  receives a CSRF token, which must be echoed in the `x-csrf-token` header for
  every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`).
- **Authentication (devices)**: `Authorization: Bearer <device-api-key>`. Device
  keys are shown once at provisioning and stored only as a SHA-256 hash.
- **Rate limits**: 400 requests/minute for `/api/*`, 600/minute for device
  telemetry, plus tighter per-route limits on login, registration, password
  reset, provisioning and command acknowledgement.
- **Security headers** on every response: CSP, `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP
  and HSTS.

## Health endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Service status, version, database mode, table counts, uptime |
| GET | `/api/health/live` | none | Liveness probe: the process is up |
| GET | `/api/health/ready` | none | Readiness probe: migrations applied and a query succeeds |
| GET | `/api/health/detailed` | none | Health plus maintenance-mode flag and table counts |

`/api/health/ready` returns `503` while migrations have not completed, so it is
the correct probe for a platform health check.

## Public

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/public/status` | none | Public status page data: zone states, latest levels, active events, whether the data is simulated |
| GET | `/api/public/config` | none | Browser-safe configuration: app name, VAPID public key, Cloudinary cloud name, firmware links |
| GET | `/api/public/service-areas` | none | Service areas open for registration |
| POST | `/api/public/subscribe` | none | Subscribe an email address to zone updates (double opt-in) |
| GET | `/api/public/verify?token=` | none | Confirm a subscription from the emailed link |
| GET | `/api/public/unsubscribe?token=` | none | Unsubscribe from the emailed link |
| GET | `/api/public/page/:slug` | none | Published site-builder page content (schema-driven blocks) |

`/api/public/status` reports `simulated: true` on every value that originates
from the simulation engine. There is no other source of fake data in the API.

## Authentication

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/auth/status` | none | Whether a session exists, whether registration is open, whether bootstrap is closed |
| GET | `/api/auth/me` | session | Current user, role, scope and CSRF token |
| POST | `/api/auth/register` | none | Register inside an allowed service area |
| POST | `/api/auth/login` | none | Email + password, optional TOTP code |
| POST | `/api/auth/logout` | session + CSRF | End the session |
| POST | `/api/auth/verify-email/resend` | session + CSRF | Resend the verification email |
| GET | `/api/auth/verify-email?token=` | none | Confirm an email address |
| POST | `/api/auth/password/forgot` | none | Start a password reset (always answers 202) |
| POST | `/api/auth/password/reset` | none | Complete a password reset |
| POST | `/api/auth/password/change` | session + CSRF | Change your own password |
| POST | `/api/auth/totp/start` | session + CSRF | Begin authenticator enrolment, returns the otpauth URL and secret |
| POST | `/api/auth/totp/confirm` | session + CSRF | Confirm enrolment with a code |
| POST | `/api/auth/bootstrap` | none | Create the first OWNER. Requires `OWNER_BOOTSTRAP_TOKEN` (32+ chars) and a source IP inside `ADMIN_CIDR_ALLOWLIST`. Permanently closed once an OWNER exists. |
| POST | `/api/auth/accept-invite` | none | Accept an admin/operator invitation |
| GET | `/api/auth/sessions` | session | List your active sessions |
| POST | `/api/auth/sessions/revoke-others` | session + CSRF | Revoke every other session |

### Roles

| Role | Scope |
| --- | --- |
| `MEMBER` | Public member inside a service area |
| `OPERATOR` | Local operator, scoped to a city/zone |
| `ADMIN` | Local administrator, scoped to `users.city_id` / `users.zone_id` |
| `OWNER` | Super administrator, whole platform |

## Current user (`/api/me`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/me/profile` | session | Profile, avatar, notification preferences |
| PUT | `/api/me/profile` | session + CSRF | Update display name, city, zone, phone |
| POST | `/api/me/avatar/signature` | session + CSRF | Signed Cloudinary upload signature |
| POST | `/api/me/avatar` | session + CSRF | Store the uploaded avatar URL |
| DELETE | `/api/me/avatar` | session + CSRF | Remove the avatar |
| PUT | `/api/me/notifications/preferences` | session + CSRF | Per-channel opt-in and minimum severity |
| POST | `/api/me/push` | session + CSRF | Register a browser push subscription |
| DELETE | `/api/me/push` | session + CSRF | Remove a push subscription |
| GET | `/api/me/push/subscriptions` | session | List registered subscriptions |
| GET | `/api/me/notifications` | session | In-app notifications |
| POST | `/api/me/notifications/:id/read` | session + CSRF | Mark one as read |
| POST | `/api/me/notifications/read-all` | session + CSRF | Mark all as read |
| GET | `/api/me/deliveries` | session | Delivery log for your own notifications |

## Device management (`/api/devices`, human-facing)

Requires `OPERATOR`, `ADMIN` or `OWNER`. Local admins only see their own scope.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/devices` | List devices with health, state and last sample |
| GET | `/api/devices/:deviceId` | One device, recent telemetry and recent commands |
| POST | `/api/devices` | Register a device (returns a one-time provisioning token and QR payload) |
| POST | `/api/devices/:deviceId/provisioning-token` | Issue a fresh provisioning token |
| POST | `/api/devices/:deviceId/approve` | Approve a pending device |
| POST | `/api/devices/:deviceId/reject` | Reject a pending device |
| POST | `/api/devices/:deviceId/enabled` | Enable or disable |
| POST | `/api/devices/:deviceId/rotate-credentials` | Issue a new API key and revoke the old one |
| POST | `/api/devices/:deviceId/revoke-credentials` | Revoke every key for the device |
| PUT | `/api/devices/:deviceId/config` | Update device configuration JSON |
| DELETE | `/api/devices/:deviceId` | Remove a device |
| GET | `/api/devices/config` | Device-facing: own configuration and approval state |
| POST | `/api/devices/barrier/commands` | Operator-issued barrier command (audited) |
| GET | `/api/devices/barrier/commands` | Recent commands |
| POST | `/api/devices/barrier/commands/:commandId/cancel` | Cancel a queued command |
| GET | `/api/devices/firmware/releases` | Firmware release metadata and configured download links |

## Device endpoints (`/api/v1`, firmware)

All of these require `Authorization: Bearer <device-api-key>`. Device ingress is
restricted by `DEVICE_CIDR_ALLOWLIST` when configured (required in production).

### `POST /api/v1/provision`

Exchange a one-time provisioning token for a device API key.

```json
{ "token": "<one-time token>", "uid": "FG32-1A2B3C", "board": "ESP32", "firmwareVersion": "1.4.0" }
```

`201`:

```json
{
  "deviceId": "…", "apiKey": "fgk_…", "heartbeatIntervalSeconds": 30,
  "endpoints": { "telemetry": "/api/v1/telemetry", "heartbeat": "/api/v1/heartbeat",
                 "commands": "/api/v1/commands", "acknowledge": "/api/v1/commands/ack",
                 "config": "/api/devices/config" },
  "config": {},
  "message": "Provisioned. Store this key in device flash. It is shown only once."
}
```

The token is single-use and expires after 24 hours. A token issued for one
board cannot be claimed by another.

### `POST /api/v1/telemetry`

`202` on acceptance:

```json
{
  "accepted": true, "seq": 42, "state": "WARNING", "previousState": "WATCH",
  "changed": true, "barrier": "RAISED", "levelCm": 41.2, "rateCmPerMin": 8.5,
  "eventId": "…", "commandId": "…", "simulated": false,
  "note": "Telemetry accepted. Barrier commands are delivered through the command poll endpoint."
}
```

Request fields: `deviceId` (or `uid`), `seq`, `levelCm`, and optionally
`rateCmPerMin`, `rainfallMm`, `sensorHealthy`, `state`, `barrierState`,
`limitSwitchLow`, `limitSwitchHigh`, `emergencyStopActive`, `faultState`,
`rssi`, `batteryMv`, `uptimeSeconds`, `firmwareVersion`, `simulated`.

Rejections:

- `409` — `seq` was already received or is out of order (replay protection).
- `403` — the device is disabled or has not been approved.
- `400` — an ESP8266 sender reported actuator or emergency-stop state.

### `GET /api/v1/commands`

```json
{ "commands": [ { "commandId": "…", "action": "RAISE", "nonce": "…", "issuedAt": "…", "expiresAt": "…", "reason": "…" } ],
  "pollAfterSeconds": 5, "serverTime": "…" }
```

Each command carries a single-use nonce and an expiry (120 s by default).
Polling marks a command `DELIVERED`, so it is returned exactly once.

### `POST /api/v1/commands/ack`

```json
{ "commandId": "…", "status": "ACKNOWLEDGED", "barrierState": "RAISED",
  "limitSwitchLow": false, "limitSwitchHigh": true }
```

Acknowledgement is idempotent: repeating it returns the same command and never
re-executes anything. The reported barrier state and limit switches are stored
on the device, and the acknowledgement is audited.

### `POST /api/v1/heartbeat`

```json
{ "uptimeSeconds": 1234, "rssi": -61, "batteryMv": 3710,
  "firmwareVersion": "1.4.0", "faultState": "NONE", "freeHeapBytes": 180000 }
```

## Administration (`/api/admin`)

`ADMIN` (scoped) or `OWNER`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/overview` | Platform overview for the admin console |
| GET | `/api/admin/users` | Users in scope |
| PATCH | `/api/admin/users/:userId` | Change role, scope or disabled state |
| POST | `/api/admin/users/:userId/mfa-reset` | Clear a user's TOTP enrolment |
| POST | `/api/admin/invites` | Invite a local admin or operator |
| GET | `/api/admin/invites` | List invitations |
| GET | `/api/admin/service-areas` | Service areas |
| POST | `/api/admin/service-areas` | Add a service area |
| PATCH | `/api/admin/service-areas/:areaId` | Update a service area |
| GET | `/api/admin/policies` | Flood policies |
| POST | `/api/admin/policies` | Create a policy |
| PUT | `/api/admin/policies/:policyId` | Update thresholds, hysteresis, confirmation, cooldown |
| GET | `/api/admin/subscribers` | Public email subscribers |
| POST | `/api/admin/records` | Create a manual record |
| GET | `/api/admin/records` | List manual records |
| GET | `/api/admin/templates` | Notification templates |
| POST | `/api/admin/templates` | Create a template |
| PUT | `/api/admin/templates/:templateId` | Update a template |
| GET | `/api/admin/settings` | Site settings (secrets redacted) |
| PUT | `/api/admin/settings` | Update site settings |
| PUT | `/api/admin/flags/:key` | Toggle a feature flag |
| POST | `/api/admin/maintenance` | Enable or disable maintenance mode |
| GET | `/api/admin/providers` | Provider status (never the credentials) |
| PUT | `/api/admin/providers/smtp` | Store SMTP settings, encrypted at rest |
| PUT | `/api/admin/providers/sms` | Store SMS gateway settings, encrypted at rest |
| POST | `/api/admin/providers/smtp/test` | Send a test email |
| POST | `/api/admin/providers/sms/test` | Send a test SMS |
| GET | `/api/admin/alerts` | Flood events |
| POST | `/api/admin/alerts/:alertId/acknowledge` | Acknowledge an event |
| GET | `/api/admin/reports` | Aggregate reporting data |
| GET | `/api/admin/audit` | Audit log |

### Site builder (`/api/admin`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/pages` | Pages with draft and published versions |
| GET | `/api/admin/pages/:pageId` | One page |
| POST | `/api/admin/pages` | Create a page |
| PUT | `/api/admin/pages/:pageId/draft` | Replace the draft (schema-validated blocks) |
| POST | `/api/admin/pages/:pageId/publish` | Publish the draft as a new version |
| POST | `/api/admin/pages/:pageId/rollback` | Roll back to a previous version |
| GET | `/api/admin/library` | Block library metadata |

Page content is a list of validated blocks. There is no arbitrary HTML or
JavaScript in stored pages, so published content cannot execute code.

## Operations console (`/api/ops`)

`OWNER` only, and only from an IP inside `OPS_CIDR_ALLOWLIST` (falling back to
`ADMIN_CIDR_ALLOWLIST`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ops/status` | Whether a credential is required, rotation settings, attempt budget |
| POST | `/api/ops/session` | Exchange the rotating credential + TOTP code for a short ops session |
| POST | `/api/ops/session/end` | End the ops session |
| GET | `/api/ops/overview` | Operational overview |
| POST | `/api/ops/maintenance` | Maintenance mode |
| POST | `/api/ops/emergency-status` | Set the global emergency status |
| POST | `/api/ops/devices/:deviceId/emergency` | Emergency stop for one device |
| POST | `/api/ops/sessions/:sessionId/revoke` | Revoke a user session |
| POST | `/api/ops/rotate` | Rotate the ops credential now (emails the new one) |
| PUT | `/api/ops/flags/:key` | Toggle a feature flag |
| GET | `/api/ops/superadmins` | List super admins |
| POST | `/api/ops/superadmins/:userId/reset-mfa` | Reset a super admin's MFA |
| GET | `/api/ops/audit` | Audit log |
| POST | `/api/ops/backups` | Request a database backup |
| GET | `/api/ops/backups` | List backups |

The rotating credential is emailed to `OPS_SECURITY_EMAIL`, stored only as a
SHA-256 hash, single-use, expires after `OPS_CREDENTIAL_TTL_MINUTES`, and is
rate-limited to `OPS_MAX_ATTEMPTS` per rotation window. It never appears in a
URL, a response body, browser source, a log line or an error message.

## Simulation (`/api/simulation`)

`ADMIN` or `OWNER`. Simulation writes to the same tables as real telemetry and
marks every row `simulated = 1`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/simulation/state` | Current simulation state |
| POST | `/api/simulation/step` | Advance one synthetic sample |
| POST | `/api/simulation/start` | Start the generator |
| POST | `/api/simulation/stop` | Stop the generator |

## Flood engine states

| State | Meaning |
| --- | --- |
| `NORMAL` | Below the watch threshold |
| `WATCH` | Above the watch threshold, or rising faster than the rate-of-rise limit |
| `WARNING` | Above the warning threshold; the barrier is commanded up where policy allows |
| `CRITICAL` | Above the critical threshold; the barrier stays latched and every channel is notified |
| `RECOVERY` | Below the recovery threshold; the barrier stays latched until the hold time elapses |

Escalation can require more than one confirming sample (`confirmation_samples`)
or confirmation from a second device in the same zone. De-escalation applies
hysteresis, and duplicate transitions inside `cooldown_seconds` are suppressed.
