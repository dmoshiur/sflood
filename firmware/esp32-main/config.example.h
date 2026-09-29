/*
  FloodGrid · ESP32 controller configuration (template)

  Copy this file to config.h next to esp32-main.ino and fill in your own values.
  config.h is git-ignored: never commit a Wi-Fi password, a provisioning token
  or a device API key. The provisioning token is single-use and short lived; the
  API key it exchanges for is written to the ESP32 flash at provisioning time
  and is never part of this repository.
*/

#pragma once

// --- Wi-Fi ---------------------------------------------------------------
#define FGW_WIFI_SSID       "your-wifi-ssid"
#define FGW_WIFI_PASSWORD   "your-wifi-password"

// --- FloodGrid API -------------------------------------------------------
// Canonical HTTPS origin of your deployment, with no trailing slash.
// Local development: "https://localhost:3000" (the dev API is plain HTTP, so
// change the sketch's client to plain WiFiClient for that case).
#define FGW_API_BASE_URL    "https://floodgrid.example.org"

// One-time provisioning token from the admin console (Devices -> issue token).
// It is exchanged once for a per-device API key and can then be cleared.
#define FGW_PROVISIONING_TOKEN "paste-the-one-time-provisioning-token"

// Board/hardware label reported at provisioning time.
#define FGW_HARDWARE_REVISION "rev-b"

// Firmware version reported in telemetry and heartbeats.
#ifndef FGW_FIRMWARE_VERSION
#define FGW_FIRMWARE_VERSION "1.4.0"
#endif
