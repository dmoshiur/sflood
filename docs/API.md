# FloodGuard API reference

All endpoints are served under `/api`. Mutating routes require the session cookie **and** the `X-CSRF-Token` header (value returned by the login/register/session endpoints). Device routes authenticate with `Authorization: Bearer <device API key>`; the key is presented once at provisioning and stored as a SHA-256 hash server-side.

## Health

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness: `{ status, mode: "turso"\|"simulation", simulation }` |
| GET | `/health/ready` | none | Readiness: `{ status: "ready", database, migrationCount, configured, demoKeysConfigured }` |

## Public API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/public/status` | none | Current state, water level, trend (`RISING`/`FALLING`/`STEADY`/`UNKNOWN`), rate of rise, barrier state, safety instructions, recent flood events, simulation flag. |
| GET | `/public/service-areas` | none | Enabled service areas (country/city). |
| GET | `/public/content/:slug` | none | Published page blocks for the site content editor. |
| GET | `/public/flood-events?limit=` | none | Recent flood events timeline. |
| POST | `/public/subscribe` | none | Double opt-in email subscription; returns generic response regardless of prior state. |

## Device API (`/api/v1`)

Rate-limited per device key; in production the routes also require `DEVICE_CIDR_ALLOWLIST`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/telemetry` | Bearer device key | Telemetry ingestion. Fields: `deviceId, seq, levelCm, rateOfRiseCmPerMin, rainfallMm, sensorHealthy, state, barrierState, limitSwitchState, emergencyStopActive, rssi, uptimeS, firmwareVersion, faultState, timestamp`. Rejects replayed/out-of-order `seq` (409), reported states inconsistent with the level (400), actuator fields from sender nodes (400). Accepted telemetry feeds the flood engine asynchronously — the response is 202 and never waits on notifications. |
| POST | `/v1/heartbeat` | Bearer device key | `uptimeS, firmwareVersion, rssi, faultState` → device health. |
| POST | `/v1/provision` | one-time token | Body: `deviceId, provisioningToken, firmwareVersion, kind`. Single-use token (24 h) minted per device by an admin; returns the per-device `apiKey` **exactly once**. |
| GET | `/v1/devices/:deviceId/commands` | Bearer device key | Pending barrier commands: `{ id, action, nonce, issuedAt, expiresAt }`. Marks them delivered. |
| POST | `/v1/devices/:deviceId/commands/:commandId/ack` | Bearer device key | Body: `nonce, status, limitSwitchState, result, failureReason`. Timing-safe nonce check; replays return 409; limit-switch feedback updates device health. |

Barrier command actions: `BARRIER_RAISE`, `BARRIER_LOWER`, `BARRIER_HOLD`, `HEALTH_CHECK`. Commands expire after 120 seconds and can be acknowledged exactly once.

## Session/auth API (`/api/auth`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Service-area allowlist enforced server-side (IP geolocation advisory only). Creates a `MEMBER`, queues the verification email. |
| GET | `/auth/verify-email?token=` | Verifies the emailed token. |
| POST | `/auth/login` | Password login (TOTP step-up when configured). |
| POST | `/auth/logout` | Ends the session. |
| GET | `/auth/session` | Current session + CSRF token. |
| POST | `/auth/bootstrap` | First `OWNER` account, guarded by `OWNER_BOOTSTRAP_TOKEN` + CIDR allowlist. |

## Profile API (`/api/profile`)

| Method | Path | Notes |
| --- | --- | --- |
| GET/PUT | `/profile` | Profile fields and notification preferences (`floodAlerts`, `recoveryAlerts`, `email`, `sms`, `push`). |
| POST | `/profile/avatar` | Cloudinary avatar upload (magic-byte validated). |
| GET | `/profile/inbox` | In-app notification inbox. |
| POST | `/profile/inbox/:id/read`, `/profile/inbox/read-all` | Mark read. |
| POST | `/profile/push/subscribe`, `/profile/push/unsubscribe` | Web Push subscription management. |

## Owner/admin API (`/api/owner`)

RBAC: `OWNER` (all sites) and `ADMIN`/`OPERATOR` (scoped to their `city_id`). Every route is enforced server-side; production requests must come from `ADMIN_CIDR_ALLOWLIST`.

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/owner/summary` | admin | Overview tiles: counts, system state, provider state. |
| GET | `/owner/users` | owner | List users. |
| POST | `/owner/users/:id/role`, `/owner/users/:id/disable\|enable` | owner | Role/session management (own-account guard). |
| POST | `/owner/users/:id/mfa/disable` | owner | Remove another admin's TOTP MFA. |
| GET/POST | `/owner/providers`, `/owner/providers/:id`, `/owner/providers/:id/test` | owner | Notification provider gateways (SMTP/SMS/Web Push) with masked secrets and live test sends. |
| GET | `/owner/devices` | admin | Device registry + telemetry health. |
| POST | `/owner/devices/:id/approve` \| `/revoke` \| `/rotate-key` | operator | Approval workflow, per-device key rotation (new key returned once). |
| POST | `/owner/devices/:id/provision-token` | operator | Mint single-use provisioning token (24 h) for the QR flow. |
| POST | `/owner/devices/:id/commands` | operator | Create `BARRIER_RAISE`/`BARRIER_LOWER`/`BARRIER_HOLD`/`HEALTH_CHECK` command (nonce + expiry). |
| GET | `/owner/devices/:id/commands` | admin | Command history with status/failure reason. |
| GET/PUT | `/owner/engine/thresholds`, `/owner/engine/automation`, `/owner/engine/features` | owner | Flood-engine config + automation policy + site feature flags. |
| GET | `/owner/flood-events` | admin | Flood event history. |
| GET/PUT | `/owner/maintenance`, `/owner/emergency` | owner (emergency: operator) | Maintenance mode + emergency site status. |
| GET/POST | `/owner/service-areas`, `/owner/service-areas/:id/toggle` | owner | Service-area allowlist management. |
| GET/PUT | `/owner/content/:slug` | owner | Content editor drafts (schema-validated blocks). |
| POST | `/owner/content/:slug/publish`, `/owner/content/:slug/rollback` | owner | Publish a revision / roll back to an earlier revision. |

## Operations API (`/api/ops`)

Rotating access: the 12-character code is minted server-side every hour, delivered to `OPS_SECURITY_EMAIL`, stored only as a SHA-256 hash and auto-expires. Attempts are rate-limited (6 per 15 minutes per IP), responses are cache-disabled and the code is never placed in URLs.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/ops/status` | Whether a code is currently issued and its window boundaries. |
| POST | `/ops/unlock` | `{ code }` → 30-minute `fg_ops` HttpOnly session cookie. |
| POST | `/ops/lock` | Revokes the ops session. |
| GET | `/ops/deployment` | Deployment/update information (version, migration count, uptime) + recent ops audit. |
| GET | `/ops/audit?limit=` | Audit trail excerpt. |
