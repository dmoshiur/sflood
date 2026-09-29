# Device setup — flashing, provisioning and firmware updates

Science-fair model only. Both sketches pin HTTPS with a locally pasted root CA and never contain backend master secrets: each device receives its own API key once, through the provisioning exchange.

## 1. Register the device in the admin console

1. Sign in as an owner/admin and open **Hackeradmin → Devices**.
2. Register the device UID (e.g. `fg-esp32-01`) with its kind: `ESP32_CONTROLLER` (sensor + barrier) or `ESP8266_SENDER` (sensor only). New devices start **PENDING**.
3. Approve the device. Only approved devices can ingest telemetry.
4. Click **Provision** to mint a single-use provisioning token (expires after 24 hours). A QR code and copy button appear; the token is shown once.

## 2. Prepare the sketch

```bash
cd firmware/esp32-main        # or firmware/esp8266-sender
cp config.example.h config.h  # config.h is Git-ignored
```

Fill `config.h`:

| Field | Value |
| --- | --- |
| `FG_WIFI_SSID` / `FG_WIFI_PASSWORD` | Your test network |
| `FG_API_BASE` / `FG_API_URL` / `FG_PROVISION_URL` | Your HTTPS API host |
| `FG_DEVICE_ID` | The UID registered in the console |
| `FG_DEVICE_API_KEY` | Leave **empty** to provision on first boot |
| `FG_PROVISIONING_TOKEN` | The one-time token from the console QR code |
| `FG_API_ROOT_CA` | The verified root CA chain for your API host (≥ 64 chars). Telemetry stays disabled until this is set — `setInsecure()` is never used. |

The per-device API key is stored in ESP32 NVS (`Preferences`) after provisioning and returned by the server **exactly once**. Keep `config.h` and any pasted keys out of Git.

## 3. Flash

Board settings (Arduino IDE):

- **ESP32 controller**: Board *ESP32 Dev Module*, 115200 baud, 240 MHz, 921600 upload. Libraries: `ESP32Servo`, Arduino ESP32 core (2.x or newer).
- **ESP8266 sender**: Board *NodeMCU 1.0 (ESP-12E)*, 115200 baud. Libraries: ESP8266 Arduino core (3.x).

Upload, then open the serial monitor at 115200 baud. On first boot the controller logs `Provisioning complete; device API key stored in NVS.` when the token exchange succeeds. After that the token is consumed — re-provision from the console if you reflash with an erased NVS.

## 4. Verify

- Serial logs show `telemetry HTTP 202 · seq …` every 10 seconds.
- **Hackeradmin → Devices** shows live level, state, RSSI, uptime and firmware version.
- **Live status** (`/status`) reflects the reported state within one telemetry interval.

## Remote command channel (ESP32 controller only)

The controller polls `/api/v1/devices/:id/commands` every telemetry interval. Each command carries a `commandId`, `nonce`, `issuedAt` and `expiresAt` (120-second TTL):

- The device executes the action only when the **local fail-safe allows it** (no E-stop, healthy sensor, and `BARRIER_LOWER` only below the recovery threshold).
- The device acknowledges **exactly once**, echoing the nonce and reporting the limit-switch state. Replayed or forged acknowledgements are rejected with 409.
- Expired commands are refused by the device and swept to `EXPIRED` by the server.
- Sender nodes never receive commands — the server refuses to create them.

## Firmware update metadata

Devices report `firmwareVersion` in every telemetry and heartbeat payload. **Hackeradmin → Devices** shows the running version per device so you can verify rollouts. Distribution of binaries is intentionally left to you: set `VITE_FIRMWARE_ESP32_URL`, `VITE_FIRMWARE_ESP8266_URL`, `VITE_FIRMWARE_GITHUB_RELEASES_URL` and `VITE_FIRMWARE_GITHUB_REPO_URL` in `.env` to publish your own download/GitHub links on `/devices`. While unset, the page says so explicitly instead of pointing at an invented URL.

## Calibration

`SENSOR_ZERO_CM` (65 cm default) is the ultrasonic sensor height above the tray floor. Measure your exact model and adjust. Thresholds on the device mirror the server defaults: watch 20 cm, warning 35 cm, critical 50 cm, recovery exit 15 cm, hysteresis 2 cm, rate-of-rise 2.5/6 cm per minute.
