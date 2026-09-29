/*
  FloodGrid · ESP32 WROOM-32 barrier controller (educational prototype)

  What this sketch does
  ---------------------
  1. Provisions itself once against the FloodGrid API using a one-time token
     and its hardware UID, then stores the per-device API key in NVS flash.
  2. Reads an HC-SR04 ultrasonic water level, filters it, and derives a local
     flood state with its own hysteresis (NORMAL/WATCH/WARNING/CRITICAL).
  3. Drives the model barrier through a servo, watching both limit switches,
     and keeps a normally-closed emergency stop in series with actuator power.
  4. Reports telemetry, polls for barrier commands, acknowledges them with the
     actuator feedback, and sends heartbeats.

  Safety contract
  ---------------
  The controller never waits for the cloud to stay safe. If Wi-Fi, DNS, TLS or
  the API is unavailable the local state machine still runs and the barrier
  still moves to its local commanded position. The physical emergency stop cuts
  actuator power regardless of what any software says.

  This is a science-fair prototype. It is not a flood defence device and must
  never be connected to real infrastructure.

  Build
  -----
  - Arduino IDE / arduino-cli with the ESP32 board package (>= 2.0.x) and the
    ESP32Servo library.
  - Copy config.example.h to config.h and fill in your own values. config.h is
    git-ignored and must never contain a committed secret: the API key is
    written to flash at provisioning time and is not part of this repository.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include <math.h>
#include "config.h"   // your local copy; see config.example.h

#ifndef FGW_FIRMWARE_VERSION
#define FGW_FIRMWARE_VERSION "1.4.0"
#endif

/* ----------------------------- pin map ----------------------------- */
// Every pin below is a prototype choice. Verify against your own wiring
// (docs/WIRING.md) before powering anything.
static const uint8_t PIN_TRIG            = 25;  // HC-SR04 Trig
static const uint8_t PIN_ECHO            = 34;  // HC-SR04 Echo (5V -> divider!)
static const uint8_t PIN_SERVO_BARRIER   = 18;  // servo signal only
static const uint8_t PIN_LIMIT_LOW       = 32;  // barrier fully down switch
static const uint8_t PIN_LIMIT_HIGH      = 33;  // barrier fully up switch
static const uint8_t PIN_ESTOP_SENSE     = 4;   // NC contact to GND, INPUT_PULLUP
static const uint8_t PIN_LOCAL_RESET     = 13;  // local fault reset push button
static const uint8_t PIN_STATUS_LED      = 2;   // on-board LED

/* --------------------------- calibration --------------------------- */
static const float   SENSOR_ZERO_CM        = 65.0f;  // sensor face -> floor distance
static const float   LEVEL_OFFSET_CM       = 0.0f;   // trim after a still-water test
static const float   WATCH_CM              = 22.0f;  // mirror the zone policy
static const float   WARNING_CM            = 36.0f;
static const float   CRITICAL_CM           = 50.0f;
static const float   HYSTERESIS_CM         = 3.0f;
static const float   RECOVERY_CM           = 17.0f;
static const uint8_t FILTER_SAMPLES        = 7;      // median window
static const float   MIN_PLAUSIBLE_CM      = 2.0f;   // below this the echo is noise
static const float   MAX_PLAUSIBLE_CM      = 400.0f; // HC-SR04 practical limit
static const uint32_t ECHO_TIMEOUT_US      = 30000;  // ~5 m round trip

/* ----------------------------- actuator ---------------------------- */
static const int     SERVO_DOWN_DEG        = 12;
static const int     SERVO_UP_DEG          = 92;
static const uint32_t ACTUATOR_TIMEOUT_MS  = 15000;  // never drive forever
static const uint32_t SWITCH_DEBOUNCE_MS   = 40;

/* ----------------------------- schedule ---------------------------- */
static const uint32_t SAMPLE_INTERVAL_MS   = 500;    // local control loop
static const uint32_t TELEMETRY_INTERVAL   = 10000;  // or immediately on change
static const uint32_t COMMAND_POLL_INTERVAL= 5000;   // matches pollAfterSeconds
static const uint32_t HEARTBEAT_INTERVAL   = 30000;
static const uint32_t WIFI_RETRY_INTERVAL  = 15000;

/* ------------------------------- state ----------------------------- */
enum FloodState { STATE_NORMAL, STATE_WATCH, STATE_WARNING, STATE_CRITICAL };
enum BarrierState { BARRIER_DOWN, BARRIER_RAISING, BARRIER_UP, BARRIER_FAULT, BARRIER_HOLD };

struct Status {
  FloodState  state;
  BarrierState barrier;
  float       levelCm;
  bool        sensorHealthy;
  bool        estopActive;
  bool        limitLow;
  bool        limitHigh;
  const char* fault;
};

static Servo       barrierServo;
static Preferences prefs;
static Status      status;

static char     apiKey[96]      = {0};   // loaded from NVS, never committed
static char     deviceUid[48]   = {0};   // stable hardware identity
static uint32_t sequenceNumber  = 0;     // persisted; the API rejects replays
static uint32_t lastSampleAt    = 0;
static uint32_t lastTelemetryAt = 0;
static uint32_t lastPollAt      = 0;
static uint32_t lastHeartbeatAt = 0;
static uint32_t lastWifiAttempt = 0;
static uint32_t actuatorStartedAt = 0;
static bool     wifiReady       = false;
static bool     provisioned     = false;
static bool     faultLatched    = false;

/* Recently executed command ids, kept in RAM so a redelivered command is never
   executed twice. The server also enforces this, but the controller must not
   depend on the network for idempotency. */
static String executedCommands[8];
static uint8_t executedCommandIndex = 0;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

static const char* stateName(FloodState state) {
  switch (state) {
    case STATE_WATCH:    return "WATCH";
    case STATE_WARNING:  return "WARNING";
    case STATE_CRITICAL: return "CRITICAL";
    default:             return "NORMAL";
  }
}

static const char* barrierName(BarrierState barrier) {
  switch (barrier) {
    case BARRIER_RAISING: return "RAISING";
    case BARRIER_UP:      return "RAISED";
    case BARRIER_FAULT:   return "FAULT";
    case BARRIER_HOLD:    return "HOLD";
    default:              return "DOWN";
  }
}

static bool alreadyExecuted(const String& commandId) {
  for (const String& seen : executedCommands) {
    if (seen.length() && seen == commandId) return true;
  }
  return false;
}

static void rememberCommand(const String& commandId) {
  executedCommands[executedCommandIndex] = commandId;
  executedCommandIndex = (executedCommandIndex + 1) % 8;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

static void loadPersistedState() {
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
  key.toCharArray(apiKey, sizeof(apiKey));
  prefs.putString("apiKey", key);
  provisioned = true;
  Serial.println("[floodgrid] device key stored in NVS");
}

static void persistSequence() {
  prefs.putUInt("seq", sequenceNumber);
}

/* ------------------------------------------------------------------ *
 * Wi-Fi and HTTP
 * ------------------------------------------------------------------ */

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiReady = true; return; }
  lastWifiAttempt = millis();
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(FGW_WIFI_SSID, FGW_WIFI_PASSWORD);
  Serial.printf("[floodgrid] connecting to Wi-Fi \"%s\"\n", FGW_WIFI_SSID);
}

static void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiReady) {
      wifiReady = true;
      Serial.printf("[floodgrid] Wi-Fi up, ip=%s rssi=%d\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
    }
    return;
  }
  wifiReady = false;
  if (millis() - lastWifiAttempt >= WIFI_RETRY_INTERVAL) connectWifi();
}

/* One HTTPS client per request. Certificate validation is disabled for the
   prototype so the sketch runs against a self-signed Render deployment; a real
   installation must pin the API root CA instead. */
static WiFiClientSecure createClient() {
  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(8000);
  return client;
}

static bool apiRequest(const char* method, const char* path, const String& body,
                       String& response, int& httpCode) {
  if (!wifiReady) return false;
  HTTPClient http;
  String url = String(FGW_API_BASE_URL) + path;
  if (!http.begin(createClient(), url)) return false;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");
  if (apiKey[0]) http.addHeader("Authorization", String("Bearer ") + apiKey);
  http.setTimeout(8000);
  httpCode = http.sendRequest(method, (uint8_t*)body.c_str(), body.length());
  response = http.getString();
  http.end();
  return httpCode > 0;
}

/* Extract a JSON string field without pulling in a JSON library. Good enough
   for the small, known response shapes this sketch reads. */
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

/* ------------------------------------------------------------------ *
 * Provisioning: one-time token + UID -> per-device API key
 * ------------------------------------------------------------------ */

static bool provisionDevice() {
  if (!FGW_PROVISIONING_TOKEN[0]) {
    Serial.println("[floodgrid] no provisioning token configured; put one in config.h");
    return false;
  }
  String body = String("{\"token\":\"") + FGW_PROVISIONING_TOKEN + "\"," +
                "\"uid\":\"" + deviceUid + "\"," +
                "\"board\":\"ESP32\"," +
                "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\"," +
                "\"hardwareRevision\":\"" FGW_HARDWARE_REVISION "\"}";
  String response;
  int code = 0;
  if (!apiRequest("POST", "/api/v1/provision", body, response, code)) return false;
  if (code != 201) {
    Serial.printf("[floodgrid] provisioning failed (%d): %s\n", code, response.c_str());
    return false;
  }
  String key = jsonField(response, "apiKey");
  if (key.length() < 16) {
    Serial.println("[floodgrid] provisioning response had no usable key");
    return false;
  }
  persistApiKey(key);
  return true;
}

/* ------------------------------------------------------------------ *
 * Water level sensing
 * ------------------------------------------------------------------ */

static float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(3);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  uint32_t duration = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return NAN;
  return (duration * 0.0343f) / 2.0f;   // speed of sound, round trip
}

static float filteredLevelCm() {
  float samples[FILTER_SAMPLES];
  uint8_t collected = 0;
  for (uint8_t i = 0; i < FILTER_SAMPLES; i++) {
    float distance = readDistanceCm();
    if (!isnan(distance) && distance >= MIN_PLAUSIBLE_CM && distance <= MAX_PLAUSIBLE_CM) {
      samples[collected++] = distance;
    }
    delay(12);
  }
  if (collected < 3) return NAN;         // not enough valid echoes
  for (uint8_t i = 1; i < collected; i++) {           // insertion sort
    float value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) { samples[j + 1] = samples[j]; j--; }
    samples[j + 1] = value;
  }
  float median = samples[collected / 2];
  float level = SENSOR_ZERO_CM - median + LEVEL_OFFSET_CM;
  return level < 0.0f ? 0.0f : level;
}

/* ------------------------------------------------------------------ *
 * Local decision logic (runs with or without the network)
 * ------------------------------------------------------------------ */

static FloodState candidateForLevel(float levelCm) {
  if (levelCm >= CRITICAL_CM) return STATE_CRITICAL;
  if (levelCm >= WARNING_CM)  return STATE_WARNING;
  if (levelCm >= WATCH_CM)    return STATE_WATCH;
  return STATE_NORMAL;
}

static float exitThresholdFor(FloodState state) {
  switch (state) {
    case STATE_CRITICAL: return CRITICAL_CM - HYSTERESIS_CM;
    case STATE_WARNING:  return WARNING_CM - HYSTERESIS_CM;
    case STATE_WATCH:    return WATCH_CM - HYSTERESIS_CM;
    default:             return RECOVERY_CM;
  }
}

static void evaluateLocalState(float levelCm) {
  FloodState candidate = candidateForLevel(levelCm);
  int candidateRank = (int)candidate;
  int currentRank = (int)status.state;

  if (candidateRank > currentRank) {
    status.state = candidate;                       // escalate immediately
  } else if (candidateRank < currentRank) {
    if (levelCm <= exitThresholdFor(status.state)) {
      status.state = candidate;                     // only after the margin clears
    }
  }
}

/* ------------------------------------------------------------------ *
 * Barrier actuation and fail-safes
 * ------------------------------------------------------------------ */

static bool readDebounced(uint8_t pin, bool& cache) {
  bool raw = digitalRead(pin);
  if (raw != cache) {
    delay(SWITCH_DEBOUNCE_MS);
    cache = digitalRead(pin);
  }
  return cache;
}

static void stopActuator() {
  barrierServo.detach();
  actuatorStartedAt = 0;
}

static void driveBarrierTowards(int targetDeg, uint8_t limitPin, bool limitClosed) {
  barrierServo.attach(PIN_SERVO_BARRIER);
  actuatorStartedAt = millis();
  while (millis() - actuatorStartedAt < ACTUATOR_TIMEOUT_MS) {
    if (digitalRead(limitPin) == limitClosed) break;   // reached the end stop
    barrierServo.write(targetDeg);
    delay(10);
  }
  stopActuator();
}

static void raiseBarrier() {
  if (status.estopActive || faultLatched) { status.barrier = BARRIER_FAULT; return; }
  if (digitalRead(PIN_LIMIT_HIGH) == LOW) { status.barrier = BARRIER_UP; return; }
  status.barrier = BARRIER_RAISING;
  driveBarrierTowards(SERVO_UP_DEG, PIN_LIMIT_HIGH, LOW);
  status.barrier = digitalRead(PIN_LIMIT_HIGH) == LOW ? BARRIER_UP : BARRIER_FAULT;
  if (status.barrier == BARRIER_FAULT) faultLatched = true;
}

static void lowerBarrier() {
  if (status.estopActive || faultLatched) { status.barrier = BARRIER_FAULT; return; }
  if (digitalRead(PIN_LIMIT_LOW) == LOW) { status.barrier = BARRIER_DOWN; return; }
  status.barrier = BARRIER_RAISING;
  driveBarrierTowards(SERVO_DOWN_DEG, PIN_LIMIT_LOW, LOW);
  status.barrier = digitalRead(PIN_LIMIT_LOW) == LOW ? BARRIER_DOWN : BARRIER_FAULT;
  if (status.barrier == BARRIER_FAULT) faultLatched = true;
}

static void holdBarrier() {
  stopActuator();
  if (status.barrier != BARRIER_UP && status.barrier != BARRIER_DOWN) status.barrier = BARRIER_HOLD;
}

static void emergencyStop() {
  stopActuator();
  status.estopActive = true;
  status.barrier = BARRIER_FAULT;
}

static void resetFault() {
  // A fault may only be cleared by hand, and only while the level is low.
  if (status.levelCm > RECOVERY_CM) {
    Serial.println("[floodgrid] fault reset refused: water level is still high");
    return;
  }
  faultLatched = false;
  status.estopActive = false;
  status.barrier = BARRIER_DOWN;
}

/** Barrier position the local policy wants for the current state. */
static BarrierState commandedBarrier() {
  if (status.state == STATE_WARNING || status.state == STATE_CRITICAL) return BARRIER_UP;
  return BARRIER_DOWN;
}

static void applyLocalPolicy() {
  BarrierState wanted = commandedBarrier();
  if (status.estopActive || faultLatched) { status.barrier = BARRIER_FAULT; return; }
  if (wanted == BARRIER_UP && status.barrier != BARRIER_UP) raiseBarrier();
  else if (wanted == BARRIER_DOWN && status.barrier != BARRIER_DOWN && status.barrier != BARRIER_RAISING) lowerBarrier();
  else holdBarrier();
}

/* ------------------------------------------------------------------ *
 * Telemetry, commands, heartbeat
 * ------------------------------------------------------------------ */

static void sendTelemetry() {
  if (!wifiReady) return;
  sequenceNumber += 1;
  persistSequence();

  String body = "{";
  body += "\"deviceId\":\"" + String(deviceUid) + "\",";
  body += "\"uid\":\"" + String(deviceUid) + "\",";
  body += "\"seq\":" + String(sequenceNumber) + ",";
  body += "\"levelCm\":" + String(status.levelCm, 1) + ",";
  body += "\"sensorHealthy\":" + String(status.sensorHealthy ? "true" : "false") + ",";
  body += "\"state\":\"" + String(stateName(status.state)) + "\",";
  body += "\"barrierState\":\"" + String(barrierName(status.barrier)) + "\",";
  body += "\"limitSwitchLow\":" + String(status.limitLow ? "true" : "false") + ",";
  body += "\"limitSwitchHigh\":" + String(status.limitHigh ? "true" : "false") + ",";
  body += "\"emergencyStopActive\":" + String(status.estopActive ? "true" : "false") + ",";
  body += "\"faultState\":\"" + String(faultLatched ? "ACTUATOR_FAULT" : (status.sensorHealthy ? "NONE" : "SENSOR_FAULT")) + "\",";
  body += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  body += "\"uptimeSeconds\":" + String(millis() / 1000) + ",";
  body += "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\"";
  body += "}";

  String response;
  int code = 0;
  if (!apiRequest("POST", "/api/v1/telemetry", body, response, code)) {
    Serial.println("[floodgrid] telemetry send failed; sequence kept for the next attempt");
    return;
  }
  if (code == 202) {
    Serial.printf("[floodgrid] telemetry %u accepted (state=%s barrier=%s)\n",
                  sequenceNumber, stateName(status.state), barrierName(status.barrier));
  } else if (code == 409) {
    Serial.println("[floodgrid] telemetry rejected as a replay; advancing the sequence");
  } else {
    Serial.printf("[floodgrid] telemetry rejected (%d): %s\n", code, response.c_str());
  }
}

static void pollCommands() {
  if (!wifiReady) return;
  String response;
  int code = 0;
  if (!apiRequest("GET", "/api/v1/commands", "", response, code) || code != 200) return;

  int cursor = 0;
  while (true) {
    int at = response.indexOf("\"commandId\"", cursor);
    if (at < 0) break;
    int colon = response.indexOf(':', at);
    int start = response.indexOf('"', colon) + 1;
    int end = response.indexOf('"', start);
    String commandId = response.substring(start, end);
    cursor = end;

    int actionAt = response.indexOf("\"action\"", end);
    int actionColon = response.indexOf(':', actionAt);
    int actionStart = response.indexOf('"', actionColon) + 1;
    int actionEnd = response.indexOf('"', actionStart);
    String action = response.substring(actionStart, actionEnd);

    if (alreadyExecuted(commandId)) {
      acknowledgeCommand(commandId, "ACKNOWLEDGED", "already executed locally");
      continue;
    }

    Serial.printf("[floodgrid] command %s -> %s\n", commandId.c_str(), action.c_str());
    if (action == "RAISE")              raiseBarrier();
    else if (action == "LOWER")         lowerBarrier();
    else if (action == "HOLD")          holdBarrier();
    else if (action == "EMERGENCY_STOP")emergencyStop();
    else if (action == "RESET_FAULT")   resetFault();
    else {
      acknowledgeCommand(commandId, "FAILED", "unsupported action");
      continue;
    }
    rememberCommand(commandId);
    acknowledgeCommand(commandId, "ACKNOWLEDGED", "");
  }
}

static void acknowledgeCommand(const String& commandId, const char* result, const char& error) {
  String body = "{\"commandId\":\"" + commandId + "\",";
  body += "\"status\":\"" + String(result) + "\",";
  body += "\"barrierState\":\"" + String(barrierName(status.barrier)) + "\",";
  body += "\"limitSwitchLow\":" + String(status.limitLow ? "true" : "false") + ",";
  body += "\"limitSwitchHigh\":" + String(status.limitHigh ? "true" : "false");
  if (error && strlen(error)) body += String(",\"error\":\"") + error + "\"";
  body += "}";
  String response;
  int code = 0;
  apiRequest("POST", "/api/v1/commands/ack", body, response, code);
}

static void sendHeartbeat() {
  if (!wifiReady) return;
  String body = "{";
  body += "\"uptimeSeconds\":" + String(millis() / 1000) + ",";
  body += "\"rssi\":" + String(WiFi.RSSI()) + ",";
  body += "\"firmwareVersion\":\"" FGW_FIRMWARE_VERSION "\",";
  body += "\"faultState\":\"" + String(faultLatched ? "ACTUATOR_FAULT" : (status.sensorHealthy ? "NONE" : "SENSOR_FAULT")) + "\"";
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
  Serial.println("\n[floodgrid] ESP32 barrier controller starting");

  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_LIMIT_LOW, INPUT_PULLUP);
  pinMode(PIN_LIMIT_HIGH, INPUT_PULLUP);
  pinMode(PIN_ESTOP_SENSE, INPUT_PULLUP);
  pinMode(PIN_LOCAL_RESET, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);

  barrierServo.setPeriodHertz(50);

  loadPersistedState();
  snprintf(deviceUid, sizeof(deviceUid), "FG32-%06llX",
           (unsigned long long)(ESP.getEfuseMac() & 0xFFFFFFULL));

  status.state = STATE_NORMAL;
  status.barrier = BARRIER_DOWN;
  status.levelCm = 0.0f;
  status.sensorHealthy = false;
  status.estopActive = false;
  status.limitLow = true;
  status.limitHigh = false;

  connectWifi();
  if (wifiReady && !provisioned) provisionDevice();
  Serial.printf("[floodgrid] uid=%s provisioned=%s sequence=%u\n",
                deviceUid, provisioned ? "yes" : "no", sequenceNumber);
}

void loop() {
  uint32_t now = millis();
  maintainWifi();

  /* Inputs first: the emergency stop and the limit switches always win. */
  status.estopActive = digitalRead(PIN_ESTOP_SENSE) == HIGH;   // NC opened = stop
  status.limitLow  = readDebounced(PIN_LIMIT_LOW, status.limitLow);
  status.limitHigh = readDebounced(PIN_LIMIT_HIGH, status.limitHigh);
  if (digitalRead(PIN_LOCAL_RESET) == LOW) resetFault();
  digitalWrite(PIN_STATUS_LED, status.state >= STATE_WARNING ? HIGH : LOW);

  if (now - lastSampleAt >= SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    float level = filteredLevelCm();
    status.sensorHealthy = !isnan(level);
    status.levelCm = status.sensorHealthy ? level : status.levelCm;
    if (status.sensorHealthy) evaluateLocalState(status.levelCm);
    else faultLatched = true;                    // never move on unreadable data
    applyLocalPolicy();
  }

  bool stateChanged = (millis() - lastTelemetryAt) >= TELEMETRY_INTERVAL;
  if (stateChanged) { lastTelemetryAt = millis(); sendTelemetry(); }
  if (now - lastPollAt >= COMMAND_POLL_INTERVAL) { lastPollAt = now; pollCommands(); }
  if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL) { lastHeartbeatAt = now; sendHeartbeat(); }

  delay(5);
}
