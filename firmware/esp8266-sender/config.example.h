// Copy to config.h locally. Keep credentials and CA material out of GitHub.
#pragma once

static const char *FG_WIFI_SSID = "SET_WIFI_NAME_LOCALLY";
static const char *FG_WIFI_PASSWORD = "SET_WIFI_PASSWORD_LOCALLY";
static const char *FG_API_URL = "https://YOUR_HOST/api/v1/telemetry";
static const char *FG_DEVICE_ID = "fg-esp8266-01";
static const char *FG_DEVICE_API_KEY = "GENERATE_A_UNIQUE_RANDOM_DEVICE_KEY_32_CHARS_MIN";
// Paste the verified root CA certificate chain for the API host.
static const char *FG_API_ROOT_CA = "";
