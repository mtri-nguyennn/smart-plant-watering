#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#include "config.h"
#include "secrets.h"


// =====================================================
// GLOBAL STATE
// =====================================================

WiFiClient client;
Preferences preferences;

unsigned long lastSensorReportTime = 0;
unsigned long lastCommandPollTime = 0;
unsigned long lastWifiRetryTime = 0;

bool pumpRunning = false;
unsigned long pumpStopTime = 0;

String activeCommandId = "";
String lastCommandId = "";


// =====================================================
// PUMP
// =====================================================

void writePumpPin(bool on) {
  if (PUMP_ACTIVE_HIGH) {
    digitalWrite(PUMP_PIN, on ? HIGH : LOW);
  } else {
    digitalWrite(PUMP_PIN, on ? LOW : HIGH);
  }
}


void startPump(unsigned int durationSec) {

  // Local hardware protection
  if (durationSec > MAX_PUMP_DURATION_SEC) {
    durationSec = MAX_PUMP_DURATION_SEC;
  }

  if (durationSec == 0) {
    return;
  }

  writePumpPin(true);

  pumpRunning = true;

  pumpStopTime =
      millis() + ((unsigned long)durationSec * 1000UL);

  Serial.print("Pump STARTED for ");
  Serial.print(durationSec);
  Serial.println(" seconds");
}


void stopPump() {

  writePumpPin(false);

  pumpRunning = false;
  pumpStopTime = 0;

  Serial.println("Pump STOPPED");
}


String getPumpState() {
  return pumpRunning ? "ON" : "OFF";
}


// =====================================================
// WIFI
// =====================================================

void connectWiFi() {

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.println();
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}


void maintainWiFi() {

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  unsigned long now = millis();

  if (now - lastWifiRetryTime >= WIFI_RETRY_INTERVAL_MS) {

    lastWifiRetryTime = now;

    Serial.println("WiFi disconnected. Reconnecting...");

    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}


// =====================================================
// HTTP HELPER
// =====================================================

void addCommonHeaders(HTTPClient &http) {

  http.addHeader(
      "Content-Type",
      "application/json"
  );

  if (strlen(DEVICE_API_KEY) > 0) {
    http.addHeader(
        "X-Device-Key",
        DEVICE_API_KEY
    );
  }
}


// =====================================================
// SENSOR
// =====================================================

int readMoistureRaw() {

  int raw = analogRead(SENSOR_PIN);

  Serial.print("Moisture raw: ");
  Serial.println(raw);

  return raw;
}


// =====================================================
// SEND READING TO BACKEND
// =====================================================

bool sendSensorReading() {

  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  int moistureRaw = readMoistureRaw();

  JsonDocument doc;

  doc["deviceId"] = DEVICE_ID;
  doc["moistureRaw"] = moistureRaw;
  doc["pumpState"] = getPumpState();

  String jsonBody;
  serializeJson(doc, jsonBody);

  String url =
      String(API_BASE_URL) +
      "/api/readings";

  HTTPClient http;

  if (!http.begin(client, url)) {
    Serial.println("HTTP begin failed");
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);

  addCommonHeaders(http);

  int statusCode = http.POST(jsonBody);

  Serial.print("POST /api/readings -> ");
  Serial.println(statusCode);

  if (statusCode > 0) {

    String response =
        http.getString();

    Serial.println(response);
  }

  http.end();

  return statusCode >= 200 &&
         statusCode < 300;
}


// =====================================================
// SEND COMMAND RESULT
// =====================================================

bool sendCommandResult(
    const String &commandId,
    const String &status,
    const String &message
) {

  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  JsonDocument doc;

  doc["deviceId"] = DEVICE_ID;
  doc["commandId"] = commandId;
  doc["status"] = status;
  doc["pumpState"] = getPumpState();
  doc["message"] = message;

  String jsonBody;

  serializeJson(
      doc,
      jsonBody
  );

  String url =
      String(API_BASE_URL) +
      "/api/pump/result";

  HTTPClient http;

  if (!http.begin(client, url)) {
    return false;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);

  addCommonHeaders(http);

  int statusCode =
      http.POST(jsonBody);

  Serial.print(
      "POST /api/pump/result -> "
  );

  Serial.println(statusCode);

  if (statusCode > 0) {
    Serial.println(
        http.getString()
    );
  }

  http.end();

  return statusCode >= 200 &&
         statusCode < 300;
}


// =====================================================
// SAVE LAST COMMAND
// =====================================================

void saveLastCommand(
    const String &commandId
) {

  lastCommandId = commandId;

  preferences.putString(
      "lastCmd",
      commandId
  );
}


// =====================================================
// PROCESS PUMP COMMAND
// =====================================================

void processCommand(
    JsonObject command
) {

  String commandId =
      command["id"] | "";

  String action =
      command["action"] | "";

  if (commandId.length() == 0) {

    Serial.println(
        "Invalid command: missing id"
    );

    return;
  }


  // Prevent duplicate execution
  if (commandId == lastCommandId) {
    return;
  }


  // -----------------------------------------------
  // START
  // -----------------------------------------------

  if (action == "START") {

    int durationSec =
        command["durationSec"] | 0;


    if (durationSec <= 0) {

      saveLastCommand(commandId);

      sendCommandResult(
          commandId,
          "REJECTED",
          "durationSec must be greater than 0"
      );

      return;
    }


    bool durationLimited = false;


    if (
        durationSec >
        MAX_PUMP_DURATION_SEC
    ) {

      durationSec =
          MAX_PUMP_DURATION_SEC;

      durationLimited = true;
    }


    // Stop previous pump command first
    if (pumpRunning) {
      stopPump();
    }


    activeCommandId =
        commandId;


    startPump(
        durationSec
    );


    saveLastCommand(
        commandId
    );


    if (durationLimited) {

      sendCommandResult(
          commandId,
          "STARTED",
          "Pump started with local maximum duration limit"
      );

    } else {

      sendCommandResult(
          commandId,
          "STARTED",
          "Pump started successfully"
      );
    }

    return;
  }


  // -----------------------------------------------
  // STOP
  // -----------------------------------------------

  if (action == "STOP") {

    stopPump();

    activeCommandId = "";

    saveLastCommand(
        commandId
    );

    sendCommandResult(
        commandId,
        "STOPPED",
        "Pump stopped successfully"
    );

    return;
  }


  // -----------------------------------------------
  // UNKNOWN COMMAND
  // -----------------------------------------------

  saveLastCommand(
      commandId
  );

  sendCommandResult(
      commandId,
      "REJECTED",
      "Unknown pump action"
  );
}


// =====================================================
// GET COMMAND FROM BACKEND
// =====================================================

void pollPumpCommand() {

  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  String url =
      String(API_BASE_URL) +
      "/api/pump/command?deviceId=" +
      DEVICE_ID;


  HTTPClient http;


  if (!http.begin(
          client,
          url
      )) {

    Serial.println(
        "Command HTTP begin failed"
    );

    return;
  }


  http.setTimeout(
      HTTP_TIMEOUT_MS
  );


  if (strlen(DEVICE_API_KEY) > 0) {

    http.addHeader(
        "X-Device-Key",
        DEVICE_API_KEY
    );
  }


  int statusCode =
      http.GET();


  // No pending command
  if (statusCode == 204) {

    http.end();
    return;
  }


  if (statusCode != 200) {

    Serial.print(
        "Command GET failed: "
    );

    Serial.println(
        statusCode
    );

    http.end();
    return;
  }


  String payload =
      http.getString();


  http.end();


  JsonDocument doc;


  DeserializationError error =
      deserializeJson(
          doc,
          payload
      );


  if (error) {

    Serial.print(
        "Invalid JSON command: "
    );

    Serial.println(
        error.c_str()
    );

    return;
  }


  if (doc["command"].isNull()) {
    return;
  }


  JsonObject command =
      doc["command"];


  processCommand(
      command
  );
}


// =====================================================
// AUTOMATIC PUMP TIMEOUT
// =====================================================

void updatePump() {

  if (!pumpRunning) {
    return;
  }


  /*
    signed comparison handles millis()
    overflow correctly.
  */

  if (
      (long)(
          millis() -
          pumpStopTime
      ) >= 0
  ) {

    Serial.println(
        "Pump duration completed"
    );


    stopPump();


    if (
        activeCommandId.length() > 0
    ) {

      sendCommandResult(
          activeCommandId,
          "COMPLETED",
          "Pump automatically stopped after requested duration"
      );
    }


    activeCommandId = "";
  }
}


// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);


  // -------------------------------
  // Hardware
  // -------------------------------

  pinMode(
      PUMP_PIN,
      OUTPUT
  );


  // Safety:
  // pump must start OFF
  stopPump();


  analogReadResolution(12);


  // -------------------------------
  // Persistent storage
  // -------------------------------

  preferences.begin(
      "smartplant",
      false
  );


  lastCommandId =
      preferences.getString(
          "lastCmd",
          ""
      );


  // -------------------------------
  // HTTPS
  // -------------------------------

  /*
    DEVELOPMENT ONLY.

    This disables TLS certificate verification.

    For production:
    replace with setCACert(...)
  */



  // -------------------------------
  // WiFi
  // -------------------------------

  connectWiFi();


  Serial.println(
      "ESP32 Smart Plant started"
  );
}


// =====================================================
// LOOP
// =====================================================

void loop() {

  maintainWiFi();


  /*
    This is intentionally called
    every loop so the pump can stop
    even if WiFi/backend is unavailable.
  */

  updatePump();


  unsigned long now =
      millis();


  // -----------------------------------------------
  // Sensor reporting
  // -----------------------------------------------

  if (
      now -
      lastSensorReportTime
      >=
      SENSOR_REPORT_INTERVAL_MS
  ) {

    lastSensorReportTime =
        now;

    sendSensorReading();
  }


  // -----------------------------------------------
  // Pump command polling
  // -----------------------------------------------

  if (
      now -
      lastCommandPollTime
      >=
      COMMAND_POLL_INTERVAL_MS
  ) {

    lastCommandPollTime =
        now;

    pollPumpCommand();
  }


  delay(10);
}