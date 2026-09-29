/*
  FloodGrid · ESP8266 telemetry sender (educational prototype)

  A sender node has no actuator. It only measures the water level and reports
  it, so the platform can use it as a second confirming sensor for a zone (the
  flood policy can require more than one confirming sample).

  The FloodGrid API rejects actuator and emergency-stop fields from ESP8266
  nodes with HTTP 400, so this sketch deliberately sends none: no state, no
  barrierState, no emergencyStopActive. The cloud derives the flood state.

  Safety: this sketch cannot move a barrier, so there is no local fail-safe to
  implement. Keep it as a sensing node only.

  Build: Arduino IDE / arduino-cli with the ESP8266 board package (>= 3.1.x).
  Copy config.example.h to config.h and fill in your own values.
*/

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <ESP8266HTTPClient.h>
#include <Preferences.h>
#include <math.h>
#include "config.h"

#ifndef FGW_FIRMWARE_VERSION
#define FGW_FIRMWARE_VERSION "1.4.0"
#endif

/* ----------------------------- pin map ----------------------------- */
static const uint8_t PIN_TRIG       = 4;   // D2 on a NodeMCU/Wemos D1 mini
static const uint8_t PIN_ECHO       = 5;   // D1 - 5V echo through a divider!
static const uint8_t PIN_STATUS_LED = 2;   // on-board LED (active low)

/* --------------------------- calibration --------------------------- */
static const float   SENSOR_ZERO_CM   = 65.0f;
static const float   LEVEL_OFFSET_CM  = 0.0f;
static const uint8_t FILTER_SAMPLES   = 7;
static const float   MIN_PLAUSIBLE_CM = 2.0f;
static const float   MAX_PLAUSIBLE_CM = 400.0f;
static const uint32_t ECHO_TIMEOUT_US = 30000;

/* ----------------------------- schedule ---------------------------- */
static const uint32_t SAMPLE_INTERVAL_MS    = 500;
static const uint32_t TELEMETRY_INTERVAL_MS = 15000;
static const uint32_t HEARTBEAT_INTERVAL_MS = 60000;
static const uint32_t WIFI_RETRY_INTERVAL   = 15000;

/* ------------------------------- state ----------------------------- */
static char     apiKey[96]     = {0};
static char     deviceUid[48]  = {0};
static uint32_t sequenceNumber = 0;
static uint32_t lastSampleAt   = 0;
static uint32_t lastTelemetryAt = 0;
static uint32_t lastHeartbeatAt = 0;
static uint32_t lastWifiAttempt = 0;
static float    levelCm        = 0.0f;
static bool     sensorHealthy  = false;
static bool     wifiReady      = false;
static bool     provisioned    = false;

/* ------------------------------------------------------------------ *
 * Storage: the API key lives in the ESP8266 file system, never in git.
 * ------------------------------------------------------------------ */
static void loadPersistedState() {
  Preferences prefs;
  prefs.begin("floodgrid", false);
  sequenceNumber = prefs.getUInt("seq", 0);
  String stored = prefs.getString("apiKey", "");
  stored.trim();
  if (stored.length() > 8) {
    stored.toCharArray(apiKey, sizeof(apiKey));
    provisioned = true;
  }
}

static void persistApiKey(const String& key) {
  Preferences prefs;
  prefs.begin("floodgrid", false);
  prefs.putString("apiKey", key);
  key.toCharArray(apiKey, sizeof(apiKey));
  provisioned = true;
}

static void persistSequence() {
  Preferences prefs;
  prefs.begin("floodgrid", false);
  prefs.putUInt("seq", sequenceNumber);
}

/* ------------------------------------------------------------------ *
 * Wi-Fi and HTTP
 * ------------------------------------------------------------------ */
static void connectWifi() {
  lastWifiAttempt = millis();
  WiFi.mode(WIFI_STA);
  WiFi.begin(FGW_WIFI_SSID, FGW_WIFI_PASSWORD);
  Serial.printf("[floodgrid] sender connecting to \"%s\"\n", FGW_WIFI_SSID);
}

static void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiReady) {
      wifiReady = true;
      Serial.printf("[floodgrid] sender online, ip=%s rssi=%d\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return;
  }
  wifiReady = false;
  if (millis() - lastWifiAttempt >= WIFI_RETRY_INTERVAL) connectWifi();
}

static bool apiRequest(const char* method, const char* path, const String& body,
                       String& response, int& httpCode) {
  if (!wifiReady) return false;
  WiFiClientSecure client;
  client.setInsecure();          // prototype: pin the API root CA in production
  client.setTimeout(8000);
  HTTPClient http;
  String url = String(FGW_API_BASE_URL) + path;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  if (apiKey[0]) http.addHeader("Authorization", String("Bearer ") + apiKey);
  http.setTimeout(8000);
  httpCode = http.sendRequest(method, (uint8_t*)body.c_str(), body.length());
  response = http.getString();
  http.end();
  return httpCode > 0;
}

static String jsonField(const String& json, const char* key) {
  String needle = String("\"") + key + "\"";
  int at = json.indexOf(needle);
  if (at < 0) return "";
  at = json.indexOf(':', at + needle.length());
  if (at < 0) return "";
  at++;
  while (at < (int)json.length() && json.charAt(at) == ' ') at++;
  if (at < (int)json.length() && json.charAt(at) == '"') {
    at++;
    int end = json.indexOf('"', at);
    return end < 0 ? "" : json.substring(at, end);
  }
  int end = at;
  while (end < (int)json.length() && json.charAt(end) != ',' && json.charAt(end) != '}') end++;
  return json.substring(at, end);
}

static bool provisionDevice() {
  if (!FGW_PROVISIONING_TOKEN[0]) {
    Serial.println("[floodgrid] no provisioning token configured");
    return false;
  }
  String body = String("{\"token\":\"") + FGW_PROVISIONING_TOKEN + "\"," +
                "\"uid\":\"" + deviceUid + "\"," +
                "\"board\":\"ESP8266\"," +
                "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\"}";
  String response;
  int code = 0;
  if (!apiRequest("POST", "/api/v1/provision", body, response, code)) return false;
  if (code != 201) {
    Serial.printf("[floodgrid] provisioning failed (%d): %s\n", code, response.c_str());
    return false;
  }
  String key = jsonField(response, "apiKey");
  if (key.length() < 16) return false;
  persistApiKey(key);
  return true;
}

/* ------------------------------------------------------------------ *
 * Sensing
 * ------------------------------------------------------------------ */
static float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  uint32_t duration = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return NAN;
  return (duration * 0.0343f) / 2.0f;
}

static void sampleLevel() {
  float samples[FILTER_SAMPLES];
  uint8_t collected = 0;
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    float distance = readDistanceCm();
    if (!isnan(distance) && distance >= MIN_PLAUSIBLE_CM && distance <= MAX_PLAUSIBLE_CM) {
      samples[collected++] = distance;
    }
    delay(12);
  }
  if (collected < 3) { sensorHealthy = false; return; }
  for (uint8_t i = 1; i < collected; i++) {
    float value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) { samples[j + 1] = samples[j]; j--; }
    samples[j + 1] = value;
  }
  float level = SENSOR_ZERO_CM - samples[collected / 2] + LEVEL_OFFSET_CM;
  levelCm = level < 0.0f ? 0.0f : level;
  sensorHealthy = true;
}

/* ------------------------------------------------------------------ *
 * Reporting. Note what is absent: state, barrierState and
 * emergencyStopActive. A sender node may not report actuator state.
 * ------------------------------------------------------------------ */
static void sendTelemetry() {
  if (!wifiReady) return;
  sequenceNumber += 1;
  persistSequence();
  String body = "{";
  body += "\"deviceId\":\"" + String(deviceUid) + "\",";
  body += "\"uid\":\"" + String(deviceUid) + "\",";
  body += "\"seq\":" + String(sequenceNumber) + ",";
  body += "\"levelCm\":" + String(levelCm, 1) + ",";
  body += "\"sensorHealthy\":" + String(sensorHealthy ? "true" : "false") + ",";
  body += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  body += "\"uptimeSeconds\":" + String(millis() / 1000) + ",";
  body += "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\"";
  body += "}";
  String response;
  int code = 0;
  if (!apiRequest("POST", "/api/v1/telemetry", body, response, code)) return;
  if (code == 202) {
    Serial.printf("[floodgrid] sample %u accepted (level=%.1f cm)\n", sequenceNumber, levelCm);
  } else {
    Serial.printf("[floodgrid] telemetry rejected (%d): %s\n", code, response.c_str());
  }
}

static void sendHeartbeat() {
  if (!wifiReady) return;
  String body = "{";
  body += "\"uptimeSeconds\":" + String(millis() / 1000) + ",";
  body += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  body += "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\",";
  body += "\"faultState\":\"" + String(sensorHealthy ? "NONE" : "SENSOR_FAULT") + "\"";
  body += "}";
  String response;
  int code = 0;
  apiRequest("POST", "/api/v1/heartbeat", body, response, code);
}

/* ------------------------------------------------------------------ *
 * Setup and loop
 * ------------------------------------------------------------------ */
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[floodgrid] ESP8266 sender starting");

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);
  digitalWrite(PIN_STATUS_LED, HIGH);   // LED off (active low)

  loadPersistedState();
  snprintf(deviceUid, sizeof(deviceUid), "FG8266-%06X", ESP.getChipId() & 0xFFFFFF);

  connectWifi();
  if (wifiReady && !provisioned) provisionDevice();
  Serial.printf("[floodgrid] uid=%s provisioned=%s sequence=%u\n",
                deviceUid, provisioned ? "yes" : "no", sequenceNumber);
}

void loop() {
  uint32_t now = millis();
  maintainWifi();
  digitalWrite(PIN_STATUS_LED, sensorHealthy ? HIGH : LOW);

  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    sampleLevel();
  }
  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    sendTelemetry();
  }
  if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  delay(5);
  yield();
}
