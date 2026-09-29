/*
  FloodGrid · ESP8266 sender configuration (template)

  Copy this file to config.h next to esp8266-sender.ino and fill in your own
  values. config.h is git-ignored: never commit a Wi-Fi password or a
  provisioning token. The per-device API key is written to the ESP8266 file
  system at provisioning time and is never part of this repository.
*/

#pragma once

// --- Wi-Fi ---------------------------------------------------------------
#define FGW_WIFI_SSID       "your-wifi-ssid"
#define FGW_WIFI_PASSWORD   "your-wifi-password"

// --- FloodGrid API -------------------------------------------------------
#define FGW_API_BASE_URL    "https://floodgrid.example.org"

// One-time provisioning token from the admin console. Exchange it once for a
// per-device API key, then clear it.
#define FGW_PROVISIONING_TOKEN "paste-the-one-time-provisioning-token"

#ifndef FGW_FIRMWARE_VERSION
#define FGW_FIRMWARE_VERSION "1.4.0"
#endif
