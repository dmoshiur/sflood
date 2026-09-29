# Device setup guide

How a physical board joins FloodGrid, from an unpowered ESP32 to a device that
reports telemetry and obeys barrier commands.

Everything here is a prototype workflow for the miniature-city model. No step
touches real flood infrastructure.

## 1. Before you start

- A running FloodGrid deployment (local `npm run dev` is fine) reachable over
  HTTPS from the board's network, or plain HTTP for a local trial.
- An administrator account. Local admins and operators can register devices;
  members cannot.
- An authenticator app enrolled on the administrator account: device
  registration requires a verified TOTP code.
- A board and the wiring in [`WIRING.md`](WIRING.md).

## 2. Register the board in the console

1. Sign in and open **Devices** (`/app/devices`).
2. Choose **Register device**, then:
   - **Name** — something you will recognise, e.g. `North bank controller`.
   - **Board** — `ESP32` (controller) or `ESP8266` (sender).
   - **Zone** — the monitored zone. This decides which flood policy applies and
     who gets notified.
   - **Simulation node** — leave unchecked for real hardware.
3. Submit. The console returns:
   - the device **UID**,
   - a **one-time provisioning token** (valid 24 hours, single use),
   - a **QR code** containing `{ v, type: "floodgrid-provision", uid, board,
     token, apiBase, telemetryPath, provisionPath }`.

The QR payload contains no long-lived secret: the token is single-use and
expires. Screenshot or print it now — it is shown once.

4. **Approve** the device. Until an administrator approves it, the API answers
   telemetry with `403 This device has not been approved yet`.

If a token expires, use **Issue token** on the device row to mint a new one.

## 3. Flash the firmware

```bash
cd firmware/esp32-main          # or firmware/esp8266-sender
cp config.example.h config.h    # config.h is git-ignored
```

Fill in `config.h`:

| Setting | Value |
| --- | --- |
| `FGW_WIFI_SSID` / `FGW_WIFI_PASSWORD` | Your board network |
| `FGW_API_BASE_URL` | `https://your-floodgrid-host` (no trailing slash) |
| `FGW_PROVISIONING_TOKEN` | The token from step 2 |
| `FGW_HARDWARE_REVISION` | Your own label, e.g. `rev-b` |

Build and upload with arduino-cli:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32-main
arduino-cli upload  --fqbn esp32:esp32:esp32 -p /dev/ttyUSB0 firmware/esp32-main
```

Then open the serial monitor at 115200 baud. A healthy first boot looks like:

```
[floodgrid] ESP32 barrier controller starting
[floodgrid] connecting to Wi-Fi "model-city"
[floodgrid] Wi-Fi up, ip=192.168.1.42 rssi=-58
[floodgrid] device key stored in NVS
[floodgrid] uid=FG32-1A2B3C provisioned=yes sequence=0
[floodgrid] telemetry 1 accepted (state=NORMAL barrier=DOWN)
```

Once the key is stored you can clear `FGW_PROVISIONING_TOKEN` from `config.h`.

## 4. What the board does every cycle

| Action | Endpoint | Interval |
| --- | --- | --- |
| Sample the level, run the local state machine, move the barrier | — | every 500 ms |
| Send telemetry | `POST /api/v1/telemetry` | every 10 s, or immediately on a state change |
| Poll for commands | `GET /api/v1/commands` | every 5 s |
| Acknowledge a command | `POST /api/v1/commands/ack` | immediately after executing |
| Heartbeat | `POST /api/v1/heartbeat` | every 30 s |

The controller is safe without the network: if Wi-Fi or the API is down it keeps
sensing, keeps deciding locally and keeps moving the barrier. Nothing in the
cloud is required for the barrier to rise.

## 5. Sequence numbers and replay protection

Every telemetry sample carries a monotonically increasing `seq`, persisted in
the board's flash before it is sent. The API rejects a sample whose `seq` is not
greater than the last one it accepted, with `409`. After a power cycle the
counter resumes from flash, so a reboot cannot replay old samples.

## 6. Barrier commands

`GET /api/v1/commands` returns at most five pending commands, each with a
`commandId`, an `action`, a single-use `nonce`, an `issuedAt` and an `expiresAt`
(120 s by default). Polling marks a command `DELIVERED` so it is returned
exactly once.

| Action | Controller behaviour |
| --- | --- |
| `RAISE` | Drive the barrier up until the high limit switch closes |
| `LOWER` | Drive the barrier down until the low limit switch closes |
| `HOLD` | Stop the actuator and keep the current position |
| `EMERGENCY_STOP` | Latch a fault and stop actuation |
| `RESET_FAULT` | Clear a latched fault, only while the level is low |

The controller remembers recently executed command ids in RAM so a redelivered
command is never executed twice, and the server enforces the same rule.
Acknowledgements are idempotent.

Commands can be issued by the flood policy automatically (`requestedByKind:
POLICY`) or by an operator from the console (`USER`). Both are audited.

## 7. Keys and rotation

- A device API key is shown exactly once, at provisioning, and stored only as a
  SHA-256 hash on the server.
- **Rotate credentials** in the console to issue a new key and revoke the old
  one. Re-provision the board (or write the new key to flash) before rotating
  if the board is unattended.
- **Revoke credentials** kills every key for the device immediately.
- **Disable** a device to reject telemetry without deleting its history.

## 8. ESP8266 senders

A sender has no actuator, so the API rejects `state`, `barrierState` and
`emergencyStopActive` from an ESP8266 with `400`. The sender sketch therefore
sends only `levelCm`, `sensorHealthy`, `rssi`, `uptimeSeconds` and
`firmwareVersion`.

Give a sender the same zone as a controller and set the zone policy's
`confirmation_samples` to 2: the platform then requires two independent sensors
to agree before it escalates, which is the point of a second node.

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401 A device bearer key is required` | No `Authorization` header. Check `apiKey` was loaded from flash. |
| `401 Device credentials are invalid, revoked or disabled` | Key was rotated or revoked. Re-provision. |
| `403 This device has not been approved yet` | Approve the device in the console. |
| `409 Sequence number … already received` | The board rebooted without persisting `seq`, or two boards share a UID. Check `Preferences` writes and the UID. |
| `400 ESP8266 sender nodes cannot report actuator …` | Remove `state`, `barrierState` and `emergencyStopActive` from the payload. |
| `403 Device ingress source IP is not in the configured CIDR allowlist` | Add the board's egress IP to `DEVICE_CIDR_ALLOWLIST`. |
| Telemetry accepted but no command arrives | The flood policy only commands the barrier in `auto_barrier_states`, and only ESP32 boards receive commands. |
| Level reads `NaN`/unhealthy | Check the echo divider, the 5 V rail and that the sensor face is inside `MAX_PLAUSIBLE_CM`. |

## 10. Local development without hardware

Use a simulation node: register a device with **Simulation node** checked, then
drive it from **Simulation** (`/app/simulation`). Simulation writes to the same
tables as real telemetry and marks every row `simulated = 1`, so the public
status page and the dashboards label it as simulated data.
