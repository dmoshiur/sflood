// Copy to config.h (ignored by Git) and fill in on your own board.
// Never commit Wi-Fi credentials, device API tokens, or production certificates.
// This firmware contains NO master backend secrets — the per-device API key is
// obtained once through the provisioning exchange and stored in NVS.
#pragma once

static const char *FG_WIFI_SSID = "SET_WIFI_NAME_LOCALLY";
static const char *FG_WIFI_PASSWORD = "SET_WIFI_PASSWORD_LOCALLY";
// API base for the device endpoints (no trailing slash).
static const char *FG_API_BASE = "https://YOUR_HOST/api/v1";
static const char *FG_API_URL = "https://YOUR_HOST/api/v1/telemetry";
static const char *FG_PROVISION_URL = "https://YOUR_HOST/api/v1/provision";
static const char *FG_DEVICE_ID = "fg-esp32-01";
// Leave empty to provision on first boot using the one-time token below.
static const char *FG_DEVICE_API_KEY = "";
// One-time provisioning token from the admin console QR code (expires in 24 h).
static const char *FG_PROVISIONING_TOKEN = "SET_ONE_TIME_PROVISIONING_TOKEN_HERE";
// Paste the verified root CA chain for YOUR HTTPS API. Empty means telemetry stays disabled.
static const char *FG_API_ROOT_CA = "";
