# FloodGrid firmware

Two reference sketches for the miniature-city model. Both are educational
prototypes for a science-fair build; neither is a flood defence device.

| Directory | Board | Role |
| --- | --- | --- |
| [`esp32-main`](esp32-main/) | ESP32-WROOM-32 | Controller: ultrasonic sensing, local flood state machine, servo barrier, limit switches, emergency stop, telemetry, command polling and acknowledgement |
| [`esp8266-sender`](esp8266-sender/) | ESP8266 (NodeMCU/Wemos D1 mini) | Sender: ultrasonic sensing and telemetry only. No actuator, so it never reports barrier or emergency-stop state |

## No secrets in firmware

Nothing in this repository contains a credential, and none of these sketches
should ever be shipped with one baked in:

- `config.h` is **git-ignored**. Copy `config.example.h` to `config.h` and fill
  in your own values locally.
- The **provisioning token** is single-use, expires after 24 hours and is
  exchanged once for a per-device API key.
- The **device API key** is returned by the API exactly once, at provisioning,
  and is stored in the board's own flash/NVS. It is never committed, never
  printed to a log and never sent anywhere except your own API.
- Rotate a key at any time from the admin console; the previous key stops
  working immediately.

## Provisioning flow

1. Register the board in the admin console (Devices) and approve it.
2. Issue a one-time provisioning token. The console shows a QR code containing
   the token and the device UID.
3. Put the token in `config.h`, flash the board, and watch the serial log:
   the sketch calls `POST /api/v1/provision`, receives its API key and stores
   it in flash.
4. From then on the sketch authenticates with `Authorization: Bearer <key>`.

## Local safety first

The ESP32 sketch keeps its own thresholds, its own hysteresis and its own
barrier logic. If Wi-Fi or the API is unavailable it still senses, still
decides and still moves the barrier. Put a normally-closed latching emergency
stop in series with the actuator power rail: a software fault must never be
able to hold a barrier up.

Wiring, power and calibration notes: [`docs/WIRING.md`](../docs/WIRING.md).
HTTP contract: [`docs/API.md`](../docs/API.md).
