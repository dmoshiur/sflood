# FloodGuard API reference

The API is served under `/api`. JSON error bodies may vary by route. Session-protected mutations require the session's CSRF token in `X-CSRF-Token` and the expected same-origin request. Device endpoints use `Authorization: Bearer <device-api-key>` unless noted. Device keys are returned only at provisioning/key rotation and are stored as hashes.

All telemetry and dashboard data require a configured Turso database. Without Turso, the API fails closed rather than fabricating readings.

## Health

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | None | Liveness and configured data mode. |
| GET | `/api/health/ready` | None | Database readiness. A process can be live while the database is not ready. |

## Public data

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| GET | `/api/public/status` | None | Current backend-derived state and available persisted telemetry. Missing readings remain unknown/null. |
| GET | `/api/public/service-areas` | None | Enabled registration service areas. |
| GET | `/api/public/content/:slug` | None | Published public content, when configured. |
| GET | `/api/public/flood-events?limit=` | None | Recent persisted flood events. |

## Devices (`/api/v1`)

Routes are rate-limited. In production, configure `DEVICE_CIDR_ALLOWLIST` with the device gateway's trusted source CIDRs. Provisioning secrets and device API keys must not be exposed in browser pages or source control.

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/devices/register` | User session, admin role, CSRF | Register a device in an authorized tenant/zone. The device begins pending and disabled; admin approval is a separate action. Body: `{ id, name, kind, zoneId }`. |
| POST | `/api/v1/provision` | One-time provisioning token | Exchange an approved device's provisioning token for its per-device API key. The key is returned once. |
| POST | `/api/v1/telemetry` | Bearer device key | Submit telemetry with `deviceId`, monotonically increasing `seq`, and calibrated `levelCm`; optionally include `distanceCm`, `rainfallMm`, `rateOfRiseCmPerMin`, `sensorHealthy`, `state`, `barrierState`, `limitSwitchState`, `emergencyStopActive`, `rssi`, `uptimeS`, `firmwareVersion`, `faultState`, and `timestamp`. Replayed sequence numbers are rejected. Accepted telemetry returns 202 and is persisted/processed server-side. |
| POST | `/api/v1/devices/:deviceId/telemetry` | Bearer device key | Path-scoped telemetry form. Accepts `waterLevel` as an alias for `levelCm`, `distance` for `distanceCm`, and `sensorStatus: "ok"` for healthy status. Barrier values `closed`, `open`, `opening`, `fault`, and `hold` are normalized to the device API's actuator states. |
| POST | `/api/v1/heartbeat` | Bearer device key | Update device health metadata. Body includes `deviceId` and may include `uptimeS`, `firmwareVersion`, `rssi`, and `faultState`. |
| GET | `/api/v1/devices/:deviceId/status` | Bearer device key | Read this device's current persisted status. |
| GET | `/api/v1/devices/:deviceId/readings` | Bearer device key | Read this device's persisted telemetry. |
| GET | `/api/v1/:deviceId/commands` | Bearer device key | Fetch pending commands; delivery is not device acknowledgement. |
| POST | `/api/v1/:deviceId/commands/:commandId/ack` | Bearer device key | Acknowledge command with nonce and device-reported result/status. Nonce replay and repeat acknowledgements are rejected. |

Commands are server-queued and expire. A command is not considered completed until an authenticated device acknowledgement is received. Physical actuator safety remains the firmware's responsibility.

## Authentication, profile, and administration

The following route families are session-based; mutating requests require CSRF protection.

| Route family | Purpose |
| --- | --- |
| `/api/auth/*` | Account registration/login/logout/session and first-owner bootstrap. Bootstrap is restricted by its token and source CIDR configuration. |
| `/api/profile/*` | Current user's profile, password, preferences, and related account settings. |
| `/api/owner/*` | Role-gated owner/admin device registry, provisioning, zones, and other administrative operations. |
| `/api/ops/*` | Separate rotating operations access for supported operational/audit functions. |

For exact request fields and role constraints, consult the route handlers and the UI flows in this repository. Do not assume that a listed route family implies that an external provider is configured or that hardware acknowledged an action.
