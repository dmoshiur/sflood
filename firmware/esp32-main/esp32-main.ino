/*
  FloodGuard · ESP32 WROOM main controller (science-fair model only)
  Libraries: ESP32Servo, Arduino ESP32 core.
  Copy config.example.h to config.h and replace placeholders locally.
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

constexpr uint8_t PIN_ECHO = 34;          // HC-SR04 Echo through 1k series + 2k to GND divider
constexpr uint8_t PIN_TRIG = 25;
constexpr uint8_t PIN_WATER_ADC = 26;     // Optional ADC1 input; safe to leave disconnected
constexpr uint8_t PIN_SERVO_LEFT = 18;    // Signal only. Servos use a separate regulated 5V rail
constexpr uint8_t PIN_SERVO_RIGHT = 19;
constexpr uint8_t PIN_BUZZER_DRIVER = 27; // NPN transistor driver; never drive a buzzer load directly
constexpr uint8_t PIN_ESTOP_SENSE = 4;    // NC contact to GND + INPUT_PULLUP; open = stop/fault
constexpr uint8_t PIN_LOCAL_RESET = 13;   // Momentary local reset; only works below SAFE exit threshold

constexpr float SAFE_TO_WATCH_CM = 20.0f;
constexpr float WATCH_TO_WARNING_CM = 35.0f;
constexpr float WARNING_TO_CRITICAL_CM = 50.0f;
constexpr float HYSTERESIS_CM = 2.0f;
constexpr float SENSOR_ZERO_CM = 65.0f;   // Measure/calibrate for the exact model before testing
constexpr int SERVO_DOWN_DEG = 12;
constexpr int SERVO_UP_DEG = 92;
constexpr uint32_t SAMPLE_INTERVAL_MS = 500;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 10000;
constexpr uint32_t ECHO_TIMEOUT_US = 28000;
constexpr uint8_t FILTER_SAMPLES = 7;

// Physical safety: put a normally-closed latching E-stop in series with actuator power.
// GPIO sensing is supplementary. A software fault cannot replace the physical power cut.
enum FloodState { STATE_SAFE, STATE_WATCH, STATE_WARNING, STATE_CRITICAL, STATE_UNKNOWN, STATE_FAULT };
FloodState state = STATE_UNKNOWN;
Servo servoLeft;
Servo servoRight;
Preferences preferences;
uint32_t sequenceNumber = 0; // Written by the network task only
uint32_t lastSampleAt = 0;
uint32_t lastBuzzerAt = 0;
bool sensorHealthy = false;
bool barrierLatched = false;
bool estopActive = false;
bool buzzerOn = false;
float currentLevelCm = NAN;
float currentDistanceCm = NAN;
struct TelemetrySnapshot {
  uint32_t seq;
  float levelCm;
  FloodState state;
  bool sensorHealthy;
  bool barrierLatched;
  bool estopActive;
};
TelemetrySnapshot telemetrySnapshot = {0, NAN, STATE_UNKNOWN, false, false, false};
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

FloodState classifyWithHysteresis(float levelCm, FloodState prior) {
  if (!isfinite(levelCm) || levelCm < 0.0f) return STATE_UNKNOWN;
  switch (prior) {
    case STATE_SAFE: return levelCm >= SAFE_TO_WATCH_CM ? STATE_WATCH : STATE_SAFE;
    case STATE_WATCH:
      if (levelCm >= WATCH_TO_WARNING_CM + HYSTERESIS_CM) return STATE_WARNING;
      if (levelCm < SAFE_TO_WATCH_CM - HYSTERESIS_CM) return STATE_SAFE;
      return STATE_WATCH;
    case STATE_WARNING:
      if (levelCm >= WARNING_TO_CRITICAL_CM + HYSTERESIS_CM) return STATE_CRITICAL;
      if (levelCm < WATCH_TO_WARNING_CM - HYSTERESIS_CM) return STATE_WATCH;
      return STATE_WARNING;
    case STATE_CRITICAL:
      if (levelCm < WARNING_TO_CRITICAL_CM - HYSTERESIS_CM) return STATE_WARNING;
      return STATE_CRITICAL;
    default:
      if (levelCm >= WARNING_TO_CRITICAL_CM) return STATE_CRITICAL;
      if (levelCm >= WATCH_TO_WARNING_CM) return STATE_WARNING;
      if (levelCm >= SAFE_TO_WATCH_CM) return STATE_WATCH;
      return STATE_SAFE;
  }
}

const char *stateName(FloodState value) {
  switch (value) {
    case STATE_SAFE: return "SAFE";
    case STATE_WATCH: return "WATCH";
    case STATE_WARNING: return "WARNING";
    case STATE_CRITICAL: return "CRITICAL";
    case STATE_FAULT: return "FAULT";
    default: return "UNKNOWN";
  }
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
  if (estopActive || !sensorHealthy || currentLevelCm >= SAFE_TO_WATCH_CM - HYSTERESIS_CM) return;
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
  state = classifyWithHysteresis(currentLevelCm, state);

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
  if (state == STATE_FAULT || state == STATE_UNKNOWN || state == STATE_SAFE) {
    digitalWrite(PIN_BUZZER_DRIVER, LOW); buzzerOn = false; return;
  }
  if (state == STATE_WARNING || state == STATE_CRITICAL) {
    digitalWrite(PIN_BUZZER_DRIVER, HIGH); buzzerOn = true; return;
  }
  // WATCH: short local chirp pattern (not a public warning pattern).
  const uint32_t now = millis();
  const bool shouldBeOn = (now % 1200) < 120;
  if (shouldBeOn != buzzerOn) { digitalWrite(PIN_BUZZER_DRIVER, shouldBeOn ? HIGH : LOW); buzzerOn = shouldBeOn; }
  lastBuzzerAt = now;
}

void connectNetworkIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(FG_WIFI_SSID, FG_WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 8000) delay(200);
}

bool sendTelemetry(const TelemetrySnapshot &snapshot) {
  if (WiFi.status() != WL_CONNECTED) return false;
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
  http.addHeader("Authorization", String("Bearer ") + FG_DEVICE_API_KEY);
  char payload[320];
  const float level = isfinite(snapshot.levelCm) ? snapshot.levelCm : 0.0f;
  const char *barrierState = snapshot.estopActive ? "FAULT" : !snapshot.sensorHealthy ? "HOLD" : snapshot.barrierLatched ? "RAISED" : "DOWN";
  snprintf(payload, sizeof(payload), "{\"deviceId\":\"%s\",\"seq\":%lu,\"levelCm\":%.1f,\"sensorHealthy\":%s,\"state\":\"%s\",\"barrierState\":\"%s\",\"emergencyStopActive\":%s}",
    FG_DEVICE_ID, (unsigned long)snapshot.seq, level, snapshot.sensorHealthy ? "true" : "false", stateName(snapshot.state), barrierState, snapshot.estopActive ? "true" : "false");
  const int code = http.POST((uint8_t *)payload, strlen(payload));
  const String response = http.getString();
  http.end();
  Serial.printf("telemetry HTTP %d · seq %lu · %s\n", code, (unsigned long)snapshot.seq, response.c_str());
  return code == 202;
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
  preferences.begin("floodguard", false);
  sequenceNumber = preferences.getUInt("seq", 4821);
  barrierLatched = preferences.getBool("latched", false);
  // Boot UNKNOWN. No automatic servo movement on startup; a persisted latch needs a deliberate local reset.
  state = STATE_UNKNOWN;
  stopServoSignals();
  portENTER_CRITICAL(&snapshotMux);
  telemetrySnapshot = {sequenceNumber, currentLevelCm, state, sensorHealthy, barrierLatched, estopActive};
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
    telemetrySnapshot = {0, currentLevelCm, state, sensorHealthy, barrierLatched, estopActive};
    portEXIT_CRITICAL(&snapshotMux);
    Serial.printf("state=%s level=%.1fcm sensor=%s barrier=%s latch=%s estop=%s\n",
      stateName(state), isfinite(currentLevelCm) ? currentLevelCm : -1.0f,
      sensorHealthy ? "OK" : "UNKNOWN", barrierLatched ? "RAISED" : "DOWN",
      barrierLatched ? "YES" : "NO", estopActive ? "TRIPPED" : "OK");
  }
  // HTTPS runs on a low-priority background task; cloud delays never block this local control loop.
}
