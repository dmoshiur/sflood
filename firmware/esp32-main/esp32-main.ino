/*
  FloodGuard · ESP32 WROOM main controller (science-fair model only)
  Libraries: ESP32Servo, Arduino ESP32 core.
  Copy config.example.h to config.h and replace placeholders locally.

  Features:
    - Local flood state machine: NORMAL / WATCH / WARNING / CRITICAL / RECOVERY
      with hysteresis and rate-of-rise. Local decisions never depend on the cloud.
    - One-time provisioning exchange (FG_PROVISIONING_TOKEN) that stores the
      per-device API key in NVS. Master backend secrets are never in this firmware.
    - Telemetry with water level, rate of rise, actuator state, limit switch,
      signal strength, uptime, firmware version, fault state, timestamp and a
      monotonically increasing sequence number (replay protection).
    - Remote barrier commands with command ID + nonce, 120 s expiry, single
      acknowledgement and limit-switch feedback. Expired or conflicting commands
      are refused; the local fail-safe always wins.

  This firmware is educational; do not connect it to real flood infrastructure.
*/
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ESP32Servo.h>
#include <math.h>
#include "config.h"

static const char *FG_FIRMWARE_VERSION = "0.3.0";

constexpr uint8_t PIN_ECHO = 34;          // HC-SR04 Echo through 1k series + 2k to GND divider
constexpr uint8_t PIN_TRIG = 25;
constexpr uint8_t PIN_WATER_ADC = 26;     // Optional ADC1 input; safe to leave disconnected
constexpr uint8_t PIN_SERVO_LEFT = 18;    // Signal only. Servos use a separate regulated 5V rail
constexpr uint8_t PIN_SERVO_RIGHT = 19;
constexpr uint8_t PIN_BUZZER_DRIVER = 27; // NPN transistor driver; never drive a buzzer load directly
constexpr uint8_t PIN_ESTOP_SENSE = 4;    // NC contact to GND + INPUT_PULLUP; open = stop/fault
constexpr uint8_t PIN_LOCAL_RESET = 13;   // Momentary local reset; only works below NORMAL exit threshold
constexpr uint8_t PIN_LIMIT_TOP = 32;     // Optional barrier limit switch (raised), INPUT_PULLUP
constexpr uint8_t PIN_LIMIT_BOTTOM = 33;  // Optional barrier limit switch (lowered), INPUT_PULLUP

constexpr float WATCH_MIN_CM = 20.0f;
constexpr float WARNING_MIN_CM = 35.0f;
constexpr float CRITICAL_MIN_CM = 50.0f;
constexpr float RECOVERY_EXIT_CM = 15.0f;
constexpr float HYSTERESIS_CM = 2.0f;
constexpr float RATE_WARNING_CM_PER_MIN = 2.5f;
constexpr float RATE_CRITICAL_CM_PER_MIN = 6.0f;
constexpr float SENSOR_ZERO_CM = 65.0f;   // Measure/calibrate for the exact model before testing
constexpr int SERVO_DOWN_DEG = 12;
constexpr int SERVO_UP_DEG = 92;
constexpr uint32_t SAMPLE_INTERVAL_MS = 500;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 10000;
constexpr uint32_t COMMAND_TTL_MS = 120000;  // matches the server-side command expiry
constexpr uint32_t ECHO_TIMEOUT_US = 28000;
constexpr uint8_t FILTER_SAMPLES = 7;

// Physical safety: put a normally-closed latching E-stop in series with actuator power.
// GPIO sensing is supplementary. A software fault cannot replace the physical power cut.
enum FloodState { STATE_NORMAL, STATE_WATCH, STATE_WARNING, STATE_CRITICAL, STATE_RECOVERY, STATE_UNKNOWN, STATE_FAULT };
FloodState state = STATE_UNKNOWN;
Servo servoLeft;
Servo servoRight;
Preferences preferences;
uint32_t sequenceNumber = 0; // Written by the network task only
uint32_t lastSampleAt = 0;
bool sensorHealthy = false;
bool barrierLatched = false;
bool estopActive = false;
bool buzzerOn = false;
float currentLevelCm = NAN;
float currentDistanceCm = NAN;
float previousLevelCm = NAN;
uint32_t previousLevelAtMs = 0;
float rateOfRiseCmPerMin = 0.0f;
String deviceApiKey = FG_DEVICE_API_KEY;  // replaced at runtime by provisioning when empty

struct TelemetrySnapshot {
  uint32_t seq;
  float levelCm;
  float distanceCm;
  float rateCmPerMin;
  FloodState state;
  bool sensorHealthy;
  bool barrierLatched;
  bool estopActive;
};
TelemetrySnapshot telemetrySnapshot = {0, NAN, NAN, 0.0f, STATE_UNKNOWN, false, false, false};
portMUX_TYPE snapshotMux = portMUX_INITIALIZER_UNLOCKED;

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

void sortFloats(float *values, uint8_t count) {
  for (uint8_t i = 1; i < count; i++) {
    float value = values[i];
    int j = i - 1;
    while (j >= 0 && values[j] > value) { values[j + 1] = values[j]; j--; }
    values[j + 1] = value;
  }
}

bool readMedianDistance(float &medianCm) {
  float readings[FILTER_SAMPLES];
  uint8_t count = 0;
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    const float value = readDistanceCm();
    if (isfinite(value)) readings[count++] = value;
    delay(35);
  }
  if (count < 5) return false;  // Reject noisy/mostly-missing sample windows
  sortFloats(readings, count);
  medianCm = readings[count / 2];
  return true;
}

FloodState classifyWithHysteresis(float levelCm, float rate, FloodState prior) {
  if (!isfinite(levelCm) || levelCm < 0.0f) return STATE_UNKNOWN;
  // Rate-of-rise escalation is independent of the absolute level.
  if (rate >= RATE_CRITICAL_CM_PER_MIN) return STATE_CRITICAL;
  if (rate >= RATE_WARNING_CM_PER_MIN && levelCm >= WATCH_MIN_CM - HYSTERESIS_CM) return STATE_WARNING;
  switch (prior) {
    case STATE_NORMAL:
      return levelCm >= WATCH_MIN_CM ? STATE_WATCH : STATE_NORMAL;
    case STATE_WATCH:
      if (levelCm >= WARNING_MIN_CM + HYSTERESIS_CM) return STATE_WARNING;
      if (levelCm < WATCH_MIN_CM - HYSTERESIS_CM) return STATE_RECOVERY;
      return STATE_WATCH;
    case STATE_WARNING:
      if (levelCm >= CRITICAL_MIN_CM + HYSTERESIS_CM) return STATE_CRITICAL;
      if (levelCm < WARNING_MIN_CM - HYSTERESIS_CM) return STATE_WATCH;
      return STATE_WARNING;
    case STATE_CRITICAL:
      if (levelCm < CRITICAL_MIN_CM - HYSTERESIS_CM) return STATE_WARNING;
      return STATE_CRITICAL;
    case STATE_RECOVERY:
      // RECOVERY holds until the level is below the recovery exit threshold.
      if (levelCm >= WATCH_MIN_CM) return STATE_WATCH;
      return levelCm <= RECOVERY_EXIT_CM ? STATE_NORMAL : STATE_RECOVERY;
    default:
      if (levelCm >= CRITICAL_MIN_CM) return STATE_CRITICAL;
      if (levelCm >= WARNING_MIN_CM) return STATE_WARNING;
      if (levelCm >= WATCH_MIN_CM) return STATE_WATCH;
      return STATE_NORMAL;
  }
}

const char *stateName(FloodState value) {
  switch (value) {
    case STATE_NORMAL: return "NORMAL";
    case STATE_WATCH: return "WATCH";
    case STATE_WARNING: return "WARNING";
    case STATE_CRITICAL: return "CRITICAL";
    case STATE_RECOVERY: return "RECOVERY";
    case STATE_FAULT: return "FAULT";
    default: return "UNKNOWN";
  }
}

const char *limitSwitchState() {
  const bool top = digitalRead(PIN_LIMIT_TOP) == LOW;      // NC switch closes at the raised position
  const bool bottom = digitalRead(PIN_LIMIT_BOTTOM) == LOW;
  if (top && !bottom) return "OPEN";
  if (bottom && !top) return "CLOSED";
  if (!top && !bottom) return "TRAVELING";
  return "UNKNOWN";
}

void stopServoSignals() {
  servoLeft.detach();
  servoRight.detach();
  digitalWrite(PIN_BUZZER_DRIVER, LOW);
  buzzerOn = false;
}

void setBarrierRaised() {
  if (estopActive || !sensorHealthy) return;
  // Lightweight model servos only. Physical E-stop must independently cut servo power.
  if (!servoLeft.attached()) servoLeft.attach(PIN_SERVO_LEFT, 500, 2400);
  if (!servoRight.attached()) servoRight.attach(PIN_SERVO_RIGHT, 500, 2400);
  servoLeft.write(SERVO_UP_DEG);
  servoRight.write(SERVO_UP_DEG);
  barrierLatched = true;
  preferences.putBool("latched", true);
}

void setBarrierDownLocally() {
  // Local fail-safe: never lower while the water is still near/above the watch band,
  // while the sensor is unhealthy, or while the E-stop is tripped.
  if (estopActive || !sensorHealthy || !isfinite(currentLevelCm)) return;
  if (currentLevelCm >= RECOVERY_EXIT_CM) return;
  if (!servoLeft.attached()) servoLeft.attach(PIN_SERVO_LEFT, 500, 2400);
  if (!servoRight.attached()) servoRight.attach(PIN_SERVO_RIGHT, 500, 2400);
  servoLeft.write(SERVO_DOWN_DEG);
  servoRight.write(SERVO_DOWN_DEG);
  barrierLatched = false;
  preferences.putBool("latched", false);
}

void updateLocalState() {
  estopActive = digitalRead(PIN_ESTOP_SENSE) == HIGH; // NC loop open = stop/fault
  if (estopActive) {
    state = STATE_FAULT;
    stopServoSignals();
    return;
  }
  float distance = NAN;
  currentDistanceCm = NAN;
  sensorHealthy = readMedianDistance(distance);
  if (!sensorHealthy) {
    state = STATE_UNKNOWN;
    digitalWrite(PIN_BUZZER_DRIVER, LOW);
    buzzerOn = false;
    return; // Hold position. Do not auto-lower on missing sensor data.
  }
  currentDistanceCm = distance;
  currentLevelCm = SENSOR_ZERO_CM - distance;
  if (currentLevelCm < 0.0f) currentLevelCm = 0.0f;
  // Rate of rise (cm/min) from the previous accepted sample.
  const uint32_t nowMs = millis();
  if (isfinite(previousLevelCm) && nowMs > previousLevelAtMs) {
    const float minutes = (float)(nowMs - previousLevelAtMs) / 60000.0f;
    rateOfRiseCmPerMin = minutes > 0.0f ? (currentLevelCm - previousLevelCm) / minutes : 0.0f;
  }
  previousLevelCm = currentLevelCm;
  previousLevelAtMs = nowMs;
  state = classifyWithHysteresis(currentLevelCm, rateOfRiseCmPerMin, state);

  if (state == STATE_WARNING || state == STATE_CRITICAL) {
    setBarrierRaised();
    barrierLatched = true;
  }
  if (state == STATE_CRITICAL) barrierLatched = true;

  // A local physical button is the only normal lower/reset path in this prototype.
  static uint32_t resetPressedAt = 0;
  if (digitalRead(PIN_LOCAL_RESET) == HIGH) {
    if (resetPressedAt == 0) resetPressedAt = millis();
    if (millis() - resetPressedAt >= 2000) setBarrierDownLocally();
  } else {
    resetPressedAt = 0;
  }
}

void updateBuzzer() {
  if (state == STATE_FAULT || state == STATE_UNKNOWN || state == STATE_NORMAL) {
    digitalWrite(PIN_BUZZER_DRIVER, LOW); buzzerOn = false; return;
  }
  if (state == STATE_WARNING || state == STATE_CRITICAL) {
    digitalWrite(PIN_BUZZER_DRIVER, HIGH); buzzerOn = true; return;
  }
  // WATCH and RECOVERY: short local chirp pattern (not a public warning pattern).
  const uint32_t now = millis();
  const bool shouldBeOn = (now % 1200) < 120;
  if (shouldBeOn != buzzerOn) { digitalWrite(PIN_BUZZER_DRIVER, shouldBeOn ? HIGH : LOW); buzzerOn = shouldBeOn; }
}

void connectNetworkIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(FG_WIFI_SSID, FG_WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 8000) delay(200);
}

// Tiny JSON string extractor — the platform API is flat, no ArduinoJson needed.
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

// One-time provisioning: exchange the admin-issued token for the per-device key.
// The key is stored in NVS and returned exactly once by the server.
bool provisionDeviceIfNeeded() {
  if (deviceApiKey.length() >= 16) return true;
  const String savedKey = preferences.getString("apikey", "");
  if (savedKey.length() >= 16) { deviceApiKey = savedKey; return true; }
  if (strlen(FG_PROVISIONING_TOKEN) < 8) {
    Serial.println("No device API key and no FG_PROVISIONING_TOKEN — telemetry disabled.");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) return false;
  if (strlen(FG_API_ROOT_CA) < 64) return false;
  WiFiClientSecure client;
  client.setCACert(FG_API_ROOT_CA);
  HTTPClient http;
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  if (!http.begin(client, FG_PROVISION_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  char payload[256];
  snprintf(payload, sizeof(payload), "{\"deviceId\":\"%s\",\"provisioningToken\":\"%s\",\"firmwareVersion\":\"%s\",\"kind\":\"ESP32_CONTROLLER\"}",
    FG_DEVICE_ID, FG_PROVISIONING_TOKEN, FG_FIRMWARE_VERSION);
  const int code = http.POST((uint8_t *)payload, strlen(payload));
  const String response = http.getString();
  http.end();
  String apiKey;
  if (code == 200 && jsonExtractString(response, "apiKey", apiKey) && apiKey.length() >= 16) {
    deviceApiKey = apiKey;
    preferences.putString("apikey", apiKey); // NVS only — never serialised into this sketch
    Serial.println("Provisioning complete; device API key stored in NVS.");
    return true;
  }
  Serial.printf("Provisioning failed, HTTP %d\n", code);
  return false;
}

bool sendTelemetry(const TelemetrySnapshot &snapshot) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!provisionDeviceIfNeeded()) return false;
  if (strlen(FG_API_ROOT_CA) < 64) {
    Serial.println("HTTPS disabled: install the API root CA in local config.h first.");
    return false;
  }
  WiFiClientSecure client;
  client.setCACert(FG_API_ROOT_CA); // Do not replace with setInsecure().
  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(1500);
  if (!http.begin(client, FG_API_URL)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + deviceApiKey);
  char payload[512];
  const float level = isfinite(snapshot.levelCm) ? snapshot.levelCm : 0.0f;
  char distanceJson[24];
  if (snapshot.sensorHealthy && isfinite(snapshot.distanceCm)) snprintf(distanceJson, sizeof(distanceJson), "%.1f", snapshot.distanceCm);
  else snprintf(distanceJson, sizeof(distanceJson), "null");
  const char *barrierState = snapshot.estopActive ? "FAULT" : !snapshot.sensorHealthy ? "HOLD" : snapshot.barrierLatched ? "RAISED" : "DOWN";
  snprintf(payload, sizeof(payload),
    "{\"deviceId\":\"%s\",\"seq\":%lu,\"levelCm\":%.1f,\"distanceCm\":%s,\"rateOfRiseCmPerMin\":%.2f,\"sensorHealthy\":%s,"
    "\"state\":\"%s\",\"barrierState\":\"%s\",\"limitSwitchState\":\"%s\",\"emergencyStopActive\":%s,"
    "\"rssi\":%d,\"uptimeS\":%lu,\"firmwareVersion\":\"%s\",\"faultState\":\"%s\"}",
    FG_DEVICE_ID, (unsigned long)snapshot.seq, level, distanceJson, snapshot.rateCmPerMin, snapshot.sensorHealthy ? "true" : "false",
    stateName(snapshot.state), barrierState, limitSwitchState(), snapshot.estopActive ? "true" : "false",
    WiFi.RSSI(), (unsigned long)(millis() / 1000), FG_FIRMWARE_VERSION,
    snapshot.estopActive ? "ESTOP" : snapshot.sensorHealthy ? "" : "SENSOR");
  const int code = http.POST((uint8_t *)payload, strlen(payload));
  const String response = http.getString();
  http.end();
  Serial.printf("telemetry HTTP %d · seq %lu · %s\n", code, (unsigned long)snapshot.seq, response.c_str());
  return code == 202;
}

// Remote command channel: poll, execute with local fail-safe arbitration,
// acknowledge exactly once with the echoed nonce (replay protection).
void pollAndRunCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!provisionDeviceIfNeeded()) return;
  if (strlen(FG_API_ROOT_CA) < 64) return;
  WiFiClientSecure client;
  client.setCACert(FG_API_ROOT_CA);
  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(1500);
  String url = String(FG_API_BASE) + "/devices/" + FG_DEVICE_ID + "/commands";
  if (!http.begin(client, url)) return;
  http.addHeader("Authorization", String("Bearer ") + deviceApiKey);
  const int code = http.GET();
  const String response = http.getString();
  http.end();
  if (code != 200) return;

  // The server returns a small JSON array of {id, action, nonce, issuedAt, expiresAt}.
  // Process at most one command per poll to keep parsing deterministic.
  String commandId, action, nonce, expiresAt;
  if (!jsonExtractString(response, "id", commandId)) return;
  jsonExtractString(response, "action", action);
  jsonExtractString(response, "nonce", nonce);
  jsonExtractString(response, "expiresAt", expiresAt);
  if (commandId.isEmpty() || nonce.isEmpty()) return;

  // Local fail-safe arbitration: a cloud command may never contradict the sensor.
  bool executed = true;
  const char *failure = nullptr;
  if (estopActive || !sensorHealthy) {
    executed = false; failure = "local fail-safe: E-stop active or sensor unhealthy";
  } else if (action == "BARRIER_RAISE") {
    setBarrierRaised();
  } else if (action == "BARRIER_LOWER") {
    if (isfinite(currentLevelCm) && currentLevelCm <= RECOVERY_EXIT_CM) setBarrierDownLocally();
    else { executed = false; failure = "local fail-safe: level still above the recovery threshold"; }
  } else if (action == "BARRIER_HOLD") {
    // Hold = take no actuator action.
  } else if (action == "HEALTH_CHECK") {
    // No actuator action; the acknowledgement reports health.
  } else {
    executed = false; failure = "unsupported action";
  }

  // Acknowledge exactly once with the echoed nonce.
  HTTPClient ackHttp;
  ackHttp.setConnectTimeout(1500);
  ackHttp.setTimeout(1500);
  String ackUrl = String(FG_API_BASE) + "/devices/" + FG_DEVICE_ID + "/commands/" + commandId + "/ack";
  if (!ackHttp.begin(client, ackUrl)) return;
  ackHttp.addHeader("Content-Type", "application/json");
  ackHttp.addHeader("Authorization", String("Bearer ") + deviceApiKey);
  char ackPayload[384];
  snprintf(ackPayload, sizeof(ackPayload),
    "{\"nonce\":\"%s\",\"status\":\"%s\",\"limitSwitchState\":\"%s\",\"result\":\"%s\",\"failureReason\":\"%s\"}",
    nonce.c_str(), executed ? "OK" : "FAILED", limitSwitchState(),
    executed ? "command applied under local fail-safe rules" : "command refused",
    failure ? failure : "");
  const int ackCode = ackHttp.POST((uint8_t *)ackPayload, strlen(ackPayload));
  ackHttp.end();
  Serial.printf("command %s (%s) → ack HTTP %d\n", commandId.c_str(), action.c_str(), ackCode);
}

void telemetryTask(void *parameter) {
  (void)parameter;
  for (;;) {
    connectNetworkIfNeeded(); // Network waits are isolated from the local sensor/actuator loop.
    sequenceNumber++;
    preferences.putUInt("seq", sequenceNumber); // Persist before send to prevent replay after reset.
    TelemetrySnapshot snapshot;
    portENTER_CRITICAL(&snapshotMux);
    snapshot = telemetrySnapshot;
    portEXIT_CRITICAL(&snapshotMux);
    snapshot.seq = sequenceNumber;
    sendTelemetry(snapshot);
    pollAndRunCommands();
    vTaskDelay(pdMS_TO_TICKS(TELEMETRY_INTERVAL_MS));
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_TRIG, OUTPUT); digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_WATER_ADC, INPUT);
  pinMode(PIN_BUZZER_DRIVER, OUTPUT); digitalWrite(PIN_BUZZER_DRIVER, LOW);
  pinMode(PIN_ESTOP_SENSE, INPUT_PULLUP);
  pinMode(PIN_LOCAL_RESET, INPUT_PULLDOWN);
  pinMode(PIN_LIMIT_TOP, INPUT_PULLUP);
  pinMode(PIN_LIMIT_BOTTOM, INPUT_PULLUP);
  preferences.begin("floodguard", false);
  sequenceNumber = preferences.getUInt("seq", 0);
  barrierLatched = preferences.getBool("latched", false);
  deviceApiKey = preferences.getString("apikey", FG_DEVICE_API_KEY);
  // Boot UNKNOWN. No automatic servo movement on startup; a persisted latch needs a deliberate local reset.
  state = STATE_UNKNOWN;
  stopServoSignals();
  portENTER_CRITICAL(&snapshotMux);
  telemetrySnapshot = {sequenceNumber, currentLevelCm, currentDistanceCm, rateOfRiseCmPerMin, state, sensorHealthy, barrierLatched, estopActive};
  portEXIT_CRITICAL(&snapshotMux);
  xTaskCreatePinnedToCore(telemetryTask, "fg-telemetry", 12288, nullptr, 1, nullptr, 0);
  Serial.println("FloodGuard ESP32 model controller ready · simulation hardware only.");
  Serial.println("Check physical NC E-stop, servo power rail, common ground and splash protection.");
}

void loop() {
  const uint32_t now = millis();
  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    updateLocalState();
    updateBuzzer();
    portENTER_CRITICAL(&snapshotMux);
    telemetrySnapshot = {0, currentLevelCm, currentDistanceCm, rateOfRiseCmPerMin, state, sensorHealthy, barrierLatched, estopActive};
    portEXIT_CRITICAL(&snapshotMux);
    Serial.printf("state=%s level=%.1fcm rate=%.2fcm/min sensor=%s barrier=%s latch=%s switch=%s estop=%s\n",
      stateName(state), isfinite(currentLevelCm) ? currentLevelCm : -1.0f, rateOfRiseCmPerMin,
      sensorHealthy ? "OK" : "UNKNOWN", barrierLatched ? "RAISED" : "DOWN",
      barrierLatched ? "YES" : "NO", limitSwitchState(), estopActive ? "TRIPPED" : "OK");
  }
  // HTTPS runs on a low-priority background task; cloud delays never block this local control loop.
}
