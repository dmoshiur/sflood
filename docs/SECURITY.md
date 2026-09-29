# FloodGuard security notes

This prototype takes its security controls seriously as an educational exercise. It is **not** a certified safety system; see the prototype disclaimer in the README.

## Threat model (summary)

| Asset | Threat | Control |
| --- | --- | --- |
| Backend config/secrets | Source-code leakage | Server-side env vars only; provider secrets AES-256-GCM encrypted at rest (`SETTINGS_ENCRYPTION_KEY`); masked in UI/API |
| User accounts | Credential stuffing, privilege abuse | bcrypt hashes, invite-only elevated roles, session HttpOnly/SameSite cookies, CSRF double-submit on mutations, server-side RBAC (`OWNER`/`ADMIN`/`OPERATOR`/`MEMBER`) |
| Admin surface | Unauthorized administration | Role checks on every route (hiding buttons is not security), `ADMIN_CIDR_ALLOWLIST` fail-closed in production, TOTP MFA support, per-action audit log |
| Operations console | Persistent backdoor credentials | **Rotating access**: a 12-character code is minted hourly, delivered by email, stored as SHA-256 only, never in URLs/logs/errors, attempts rate-limited (6 per 15 min/IP), auto-expiring 30-minute sessions with `HttpOnly`+`SameSite` cookie |
| Device telemetry | Spoofing/replay | Per-device API keys (hash at rest, rotate-able), monotonic sequence numbers rejected on replay, reported-state consistency validation, sender nodes cannot report actuator state, `DEVICE_CIDR_ALLOWLIST` fail-closed in production |
| Barrier commands | Replayed/forged actuator commands | Command ID + random nonce (hash at rest), 120-second TTL, single acknowledgement with timing-safe nonce compare, 409 on replay, limit-switch feedback, and **local fail-safe arbitration on the device** (cloud commands cannot contradict the sensor or the E-stop) |
| Firmware | Master-secret exfiltration | Firmware contains no backend master secrets; per-device keys are minted once via one-time provisioning tokens and stored in NVS; `config.h` is Git-ignored; HTTPS pinned with a local root CA (`setInsecure()` is never used) |
| Site content | Script injection | Schema-driven block editor with allowlisted block types and sanitised hrefs; **no arbitrary JS execution** in production pages |
| Registration | Out-of-area signups | Server-side service-area allowlist (migration-seeded); IP geolocation (`IPINFO_TOKEN`) is **advisory only** and never a security boundary |
| Notifications | Delivery leaking secrets | Provider message IDs and failure reasons recorded per recipient; secrets never appear in logs; subscription endpoints return generic responses |

## Rotating operations credential

- Generated server-side every hour (`ensureCurrentOpsCredential`), delivered to `OPS_SECURITY_EMAIL` through the queued notification pipeline.
- Stored as `sha256(code)`; plaintext exists only in the outbound email body and is never logged.
- Verification is rate-limited, failures are audited, sessions expire after 30 minutes and can be revoked early (`/api/ops/lock`).
- Prefer enabling TOTP MFA for the owning account as an additional factor; WebAuthn is a recommended future upgrade.

## Secrets handling rules baked into the code

1. Never ship master backend secrets inside downloadable firmware.
2. Never expose the ops credential in URLs, query strings, frontend JS, HTML, source, logs or error messages.
3. Session and ops cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production and path-scoped.
4. Tokens (verification, provisioning, device keys) are compared with timing-safe equality.
5. Demo/seed keys are development-only placeholders.

## Production checklist (security)

- [ ] `SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`, `OWNER_BOOTSTRAP_TOKEN` generated and backed up in a secret manager
- [ ] `ADMIN_CIDR_ALLOWLIST`, `DEVICE_CIDR_ALLOWLIST`, `OWNER_BOOTSTRAP_CIDR_ALLOWLIST` configured
- [ ] `OPS_SECURITY_EMAIL` set to a monitored mailbox
- [ ] HTTPS enforced end-to-end (`TRUST_PROXY=1` behind the Render proxy)
- [ ] SMTP/SMS providers configured through the owner console and test-sent
- [ ] TOTP MFA enabled for the owner account
- [ ] Demo keys rotated and demo/seed data removed from production
- [ ] `VITE_FIRMWARE_*` publish your real release URLs
