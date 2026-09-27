// Copy to config.h (ignored by Git) and fill in on your own board.
// Never commit Wi-Fi credentials, device API tokens, or production certificates.
#pragma once

static const char *FG_WIFI_SSID = "SET_WIFI_NAME_LOCALLY";
static const char *FG_WIFI_PASSWORD = "SET_WIFI_PASSWORD_LOCALLY";
static const char *FG_API_URL = "https://YOUR_HOST/api/v1/telemetry";
static const char *FG_DEVICE_ID = "fg-esp32-01";
static const char *FG_DEVICE_API_KEY = "GENERATE_A_UNIQUE_RANDOM_DEVICE_KEY_32_CHARS_MIN";
// Paste the verified root CA chain for YOUR HTTPS API. Empty means telemetry stays disabled.
static const char *FG_API_ROOT_CA = "";
