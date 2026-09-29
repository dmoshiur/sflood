// Copy to config.h locally. Keep credentials and CA material out of GitHub.
// This firmware contains NO master backend secrets — the per-device API key is
// obtained once through the provisioning exchange.
#pragma once

static const char *FG_WIFI_SSID = "SET_WIFI_NAME_LOCALLY";
static const char *FG_WIFI_PASSWORD = "SET_WIFI_PASSWORD_LOCALLY";
static const char *FG_API_URL = "https://YOUR_HOST/api/v1/telemetry";
static const char *FG_PROVISION_URL = "https://YOUR_HOST/api/v1/provision";
static const char *FG_DEVICE_ID = "fg-esp8266-01";
// Leave empty to provision on first boot using the one-time token below.
static const char *FG_DEVICE_API_KEY = "";
// One-time provisioning token from the admin console QR code (expires in 24 h).
static const char *FG_PROVISIONING_TOKEN = "SET_ONE_TIME_PROVISIONING_TOKEN_HERE";
// Paste the verified root CA certificate chain for the API host.
static const char *FG_API_ROOT_CA = "";
