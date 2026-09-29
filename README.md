# FloodGuard

FloodGuard is an educational IoT flood-monitoring and model-barrier prototype. It combines ESP32/ESP8266 device firmware, a server-side API, Turso persistence, and a responsive web dashboard for stored readings, flood alerts, device status, and device administration.

> **Safety:** This is a prototype, not a certified flood-monitoring, flood-defense, or emergency-warning system. Never rely on it to protect people or property. Hardware, wiring, deployment, and readings must be independently tested and supervised.

## Data and operating model

- Product values come from device telemetry, persisted Turso records, or backend-derived status. Missing telemetry is shown as unavailable/offline; the application does not generate sample readings.
- Configure `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` for database-backed operation. Without a configured database, protected data operations fail closed and status remains unknown/offline.
- Device control requests are queued. The UI reports command progress and waits for device acknowledgement; a queued command is not evidence that an actuator moved.
- Device API keys and provisioning credentials are handled server-side. Firmware examples use placeholders; do not commit real keys or secrets.

## Run locally

Requires Node.js 20.19 or newer.

```bash
npm ci
cp .env.example .env
# Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN for database-backed use.
npm run db:migrate
npm run db:seed   # creates base tenant/project metadata only; no users, devices, or readings
npm run dev
```

Open <http://localhost:5173>. Vite proxies relative `/api` requests to the Express API on port 3000. Use a separate development database; do not point local experiments at production data. The seed command creates the initial tenant/project/city/zone metadata required for onboarding; it never creates users, devices, or telemetry. Review and update the seeded project metadata and service-area allowlist before allowing account registration.

```bash
npm run build   # server and client typechecks, then production client bundle
npm test        # server-side test suite
npm start       # production server; reads API_PORT (default 3000)
```

## Application capabilities

- Tenant-scoped dashboard and historical telemetry with time-range and device filters.
- Persisted alerts and event history; acknowledgeable alerts where authorized.
- Device registry and admin onboarding: register, approve, provision, rename, and revoke devices.
- Profile and password settings.
- ESP32 controller and ESP8266 telemetry-sender firmware, with server-mediated device authentication and command acknowledgement.

Capabilities may depend on the database schema, account role, and environment configuration. An unconfigured integration is not represented as active.

## Device and API documentation

- [API reference](docs/API.md)
- [Device setup](docs/DEVICE_SETUP.md)
- [Wiring and safety](docs/WIRING.md)
- [Security notes](docs/SECURITY.md)
- [Deployment guide](docs/DEPLOYMENT.md)

## Security configuration

Keep secrets in a deployment secret manager or local ignored `.env` file. At minimum, production requires Turso credentials, independent high-entropy `SETTINGS_ENCRYPTION_KEY` and `SESSION_SECRET` values, secure session cookies, and appropriately scoped `ADMIN_CIDR_ALLOWLIST` and `DEVICE_CIDR_ALLOWLIST` values. See [.env.example](.env.example) and [docs/SECURITY.md](docs/SECURITY.md). Never expose database or provider credentials in browser code or firmware.

## Verification status

Build and automated test commands can be run locally with the commands above. Passing those checks does not establish that a production Turso database, deployment, notification provider, or physical device has been configured or verified.
