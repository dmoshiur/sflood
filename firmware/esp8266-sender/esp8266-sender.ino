/*
  FloodGuard · NodeMCU ESP8266 sender-only firmware (science-fair model only)
  No servo, motor, barrier or buzzer pins are defined on this node.
  Copy config.example.h to config.h and fill local credentials and the verified CA.

  This node only reports sensor telemetry (level, rate of rise, health, RSSI,
  uptime, firmware version, timestamp, sequence). It never receives or executes
  barrier commands — the server refuses them for sender-kind devices as well.
*/
#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <EEPROM.h>
#include <math.h>
#include "config.h"

static const char *FG_FIRMWARE_VERSION = "0.3.0";

constexpr uint8_t PIN_TRIG = D1;       // GPIO 5
constexpr uint8_t PIN_ECHO = D2;       // GPIO 4; Echo MUST use 1kΩ series + 2kΩ to GND divider
constexpr float SENSOR_ZERO_CM = 65.0f; // Calibrate for your exact tray, mount and sensor
constexpr uint32_t ECHO_TIMEOUT_US = 28000;
constexpr uint32_t SAMPLE_INTERVAL_MS = 10000;
constexpr uint8_t FILTER_SAMPLES = 7;
constexpr int EEPROM_BYTES = 16;
constexpr int EEPROM_SEQ_ADDRESS = 0;

uint32_t sequenceNumber = 916;
uint32_t lastSampleAt = 0;
float latestLevelCm = NAN;
float previousLevelCm = NAN;
uint32_t previousLevelAtMs = 0;
float rateOfRiseCmPerMin = 0.0f;
bool latestSensorHealthy = false;
String deviceApiKey = FG_DEVICE_API_KEY; // replaced at runtime by provisioning when empty

float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  const uint32_t echoUs = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  if (echoUs == 0) return NAN;
  const float distanceCm = (float)echoUs * 0.0343f / 2.0f;
  if (distanceCm < 2.0f || distanceCm > 400.0f) return NAN;
  return distanceCm;
}

bool readFilteredLevel(float &levelCm) {
  float readings[FILTER_SAMPLES];
  uint8_t count = 0;
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    const float value = readDistanceCm();
    if (isfinite(value)) readings[count++] = value;
    delay(40);
  }
  if (count < 5) return false;
  for (uint8_t i = 1; i < count; i++) {
    float value = readings[i];
    int j = i - 1;
    while (j >= 0 && readings[j] > value) { readings[j + 1] = readings[j]; j--; }
    readings[j + 1] = value;
  }
  levelCm = SENSOR_ZERO_CM - readings[count / 2];
  if (levelCm < 0) levelCm = 0;
  return true;
}

void connectNetworkIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(FG_WIFI_SSID, FG_WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 8000) delay(200);
}

// Tiny JSON string extractor matching the platform's flat provisioning response.
bool jsonExtractString(const String &body, const char *key, String &out) {
  const String needle = String("\"") + key + "\":\"";
  const int start = body.indexOf(needle);
  if (start < 0) return false;
  const int valueStart = start + needle.length();
  const int valueEnd = body.indexOf('"', valueStart);
  if (valueEnd < 0) return false;
  out = body.substring(valueStart, valueEnd);
  return true;
}

bool provisionDeviceIfNeeded() {
  if (deviceApiKey.length() >= 16) return true;
  if (strlen(FG_PROVISIONING_TOKEN) < 8) {
    Serial.println("No device API key and no FG_PROVISIONING_TOKEN — telemetry disabled.");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) return false;
  if (strlen(FG_API_ROOT_CA) < 64) return false;
  BearSSL::X509List rootCa(FG_API_ROOT_CA);
  BearSSL::WiFiClientSecure client;
  client.setTrustAnchors(&rootCa);
  HTTPClient http;
  if (!http.begin(client, FG_PROVISION_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  char payload[256];
  snprintf(payload, sizeof(payload), "{\"deviceId\":\"%s\",\"provisioningToken\":\"%s\",\"firmwareVersion\":\"%s\",\"kind\":\"ESP8266_SENDER\"}",
    FG_DEVICE_ID, FG_PROVISIONING_TOKEN, FG_FIRMWARE_VERSION);
  const int code = http.POST((uint8_t *)payload, strlen(payload));
  const String response = http.getString();
  http.end();
  String apiKey;
  if (code == 200 && jsonExtractString(response, "apiKey", apiKey) && apiKey.length() >= 16) {
    deviceApiKey = apiKey; // kept in RAM; re-provision with a new token after a flash erase
    Serial.println("Provisioning complete; per-device API key acquired.");
    return true;
  }
  Serial.printf("Provisioning failed, HTTP %d\n", code);
  return false;
}

bool postTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!provisionDeviceIfNeeded()) return false;
  if (strlen(FG_API_ROOT_CA) < 64) {
    Serial.println("HTTPS disabled: add the verified API root CA to local config.h.");
    return false;
  }
  BearSSL::X509List rootCa(FG_API_ROOT_CA);
  BearSSL::WiFiClientSecure client;
  client.setTrustAnchors(&rootCa); // Do not use setInsecure().
  HTTPClient http;
  if (!http.begin(client, FG_API_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + deviceApiKey);
  char payload[384];
  const float level = isfinite(latestLevelCm) ? latestLevelCm : 0.0f;
  snprintf(payload, sizeof(payload),
    "{\"deviceId\":\"%s\",\"seq\":%lu,\"levelCm\":%.1f,\"rateOfRiseCmPerMin\":%.2f,\"sensorHealthy\":%s,"
    "\"rssi\":%d,\"uptimeS\":%lu,\"firmwareVersion\":\"%s\",\"faultState\":\"%s\",\"timestamp\":\"%lu\"}",
    FG_DEVICE_ID, (unsigned long)sequenceNumber, level, rateOfRiseCmPerMin, latestSensorHealthy ? "true" : "false",
    WiFi.RSSI(), (unsigned long)(millis() / 1000), FG_FIRMWARE_VERSION,
    latestSensorHealthy ? "" : "SENSOR", (unsigned long)millis());
  const int code = http.POST((uint8_t *)payload, strlen(payload));
  Serial.printf("telemetry HTTP %d · seq %lu\n", code, (unsigned long)sequenceNumber);
  http.end();
  return code == 202;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);
  EEPROM.begin(EEPROM_BYTES);
  uint32_t saved = 0;
  EEPROM.get(EEPROM_SEQ_ADDRESS, saved);
  if (saved >= 916 && saved < 0xFFFFFF00UL) sequenceNumber = saved;
  connectNetworkIfNeeded();
  Serial.println("FloodGuard sender-only node ready · no actuator control.");
  Serial.println("Verify the Echo divider before powering the HC-SR04.");
}

void loop() {
  if (millis() - lastSampleAt < SAMPLE_INTERVAL_MS) { delay(20); return; }
  lastSampleAt = millis();
  latestSensorHealthy = readFilteredLevel(latestLevelCm);
  const uint32_t nowMs = millis();
  if (latestSensorHealthy && isfinite(latestLevelCm) && isfinite(previousLevelCm) && nowMs > previousLevelAtMs) {
    const float minutes = (float)(nowMs - previousLevelAtMs) / 60000.0f;
    rateOfRiseCmPerMin = minutes > 0.0f ? (latestLevelCm - previousLevelCm) / minutes : 0.0f;
    previousLevelCm = latestLevelCm;
    previousLevelAtMs = nowMs;
  } else if (latestSensorHealthy && isfinite(latestLevelCm)) {
    previousLevelCm = latestLevelCm;
    previousLevelAtMs = nowMs;
  }
  Serial.printf("sensor=%s level=%.1fcm rate=%.2fcm/min seq=%lu\n",
    latestSensorHealthy ? "OK" : "UNKNOWN", isfinite(latestLevelCm) ? latestLevelCm : -1.0f,
    rateOfRiseCmPerMin, (unsigned long)sequenceNumber + 1);
  connectNetworkIfNeeded();
  sequenceNumber++;
  EEPROM.put(EEPROM_SEQ_ADDRESS, sequenceNumber); // persist before network send; avoids replay after restart
  EEPROM.commit();
  postTelemetry(); // Network failure does not grant this node actuator authority.
}
