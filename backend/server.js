require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CONFIG = {
  port: readIntegerEnv("PORT", 3000, 1, 65535),
  frontendOrigins: readCsvEnv("FRONTEND_ORIGINS", [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]),
  deviceApiKey: process.env.DEVICE_API_KEY || "",
  onlineTimeoutMs: readIntegerEnv("DEVICE_ONLINE_TIMEOUT_MS", 15000, 1000, 600000),
  moistureRawWet: readIntegerEnv("MOISTURE_RAW_WET", 3000, 0, 4095),
  moistureRawDry: readIntegerEnv("MOISTURE_RAW_DRY", 4000, 0, 4095),
  soilDryMaxPercent: readNumberEnv("SOIL_DRY_MAX_PERCENT", 30, 0, 100),
  soilMoistMaxPercent: readNumberEnv("SOIL_MOIST_MAX_PERCENT", 65, 0, 100),
  maxPumpDurationSec: readIntegerEnv("MAX_PUMP_DURATION_SEC", 30, 1, 3600),
  autoWaterEnabled: readBooleanEnv("AUTO_WATER_ENABLED", false),
  autoWaterThresholdPercent: readNumberEnv("AUTO_WATER_THRESHOLD_PERCENT", 30, 0, 100),
  autoWaterDurationSec: readIntegerEnv("AUTO_WATER_DURATION_SEC", 10, 1, 3600),
  autoWaterCooldownMs: readIntegerEnv("AUTO_WATER_COOLDOWN_MINUTES", 60, 1, 1440) * 60_000,
  autoWaterHysteresisPercent: readNumberEnv("AUTO_WATER_HYSTERESIS_PERCENT", 5, 0, 100),
  readingsFile: path.join(__dirname, "data", "readings.json"),
};

validateConfiguration();
ensureReadingsFile();

// Persistent data is limited to readings. Device, command, and automatic-watering
// state reset when this simple single-instance backend is restarted.
const devices = new Map();
const commands = new Map();
const pendingCommandByDevice = new Map();
const autoWaterByDevice = new Map();

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------

app.use(cors({
  origin(origin, callback) {
    if (!origin || CONFIG.frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));
app.use(express.json({ limit: "32kb" }));

// -----------------------------------------------------------------------------
// Health and public configuration
// -----------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/config", (_req, res) => {
  res.json({
    maxPumpDurationSec: CONFIG.maxPumpDurationSec,
    onlineTimeoutMs: CONFIG.onlineTimeoutMs,
  });
});

// -----------------------------------------------------------------------------
// Frontend -> Backend: automatic watering settings
// These settings do not affect the ESP32 API contract.
// -----------------------------------------------------------------------------

app.get("/api/auto-water", (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  res.json({ deviceId, ...toPublicAutoWater(getAutoWaterSettings(deviceId)) });
});

app.put("/api/auto-water", (req, res) => {
  const deviceId = requireDeviceId(req.body.deviceId);
  const enabled = requireBoolean(req.body.enabled, "enabled");
  const thresholdPercent = requireNumber(req.body.thresholdPercent, "thresholdPercent", 0, 100);
  const durationSec = requireInteger(req.body.durationSec, "durationSec", 1, CONFIG.maxPumpDurationSec);
  const cooldownMinutes = requireInteger(req.body.cooldownMinutes, "cooldownMinutes", 1, 1440);
  const hysteresisPercent = requireNumber(
    req.body.hysteresisPercent,
    "hysteresisPercent",
    0,
    100
  );

  if (thresholdPercent + hysteresisPercent > 100) {
    throw apiError(
      400,
      "INVALID_AUTO_WATER_CONFIG",
      "thresholdPercent + hysteresisPercent must not exceed 100"
    );
  }

  const settings = getAutoWaterSettings(deviceId);
  Object.assign(settings, {
    enabled,
    thresholdPercent,
    durationSec,
    cooldownMs: cooldownMinutes * 60_000,
    hysteresisPercent,
  });

  // Toggling automation on permits the next qualifying sensor reading to run.
  if (enabled) settings.armed = true;

  res.json({
    message: "Automatic watering settings saved",
    deviceId,
    ...toPublicAutoWater(settings),
  });
});

// -----------------------------------------------------------------------------
// ESP32 -> Backend: sensor readings
// Expected body: { deviceId, moistureRaw, pumpState }
// -----------------------------------------------------------------------------

app.post("/api/readings", requireDeviceAuth, (req, res) => {
  const deviceId = requireDeviceId(req.body.deviceId);
  const moistureRaw = requireInteger(req.body.moistureRaw, "moistureRaw", 0, 4095);
  const pumpState = requireEnum(req.body.pumpState, "pumpState", ["ON", "OFF"]);

  const reading = {
    id: crypto.randomUUID(),
    deviceId,
    moistureRaw,
    moisturePercentage: calculateMoisturePercentage(moistureRaw),
    soilCondition: determineSoilCondition(calculateMoisturePercentage(moistureRaw)),
    pumpState,
    timestamp: new Date().toISOString(),
  };

  appendReading(reading);
  touchDevice(deviceId, { latestReading: reading, pumpState });
  evaluateAutoWatering(deviceId, reading);

  res.status(201).json({ message: "Reading stored", reading });
});

// -----------------------------------------------------------------------------
// ESP32 -> Backend: command polling
// Contract intentionally unchanged: 204, or 200 { command: { id, action, durationSec? } }
// -----------------------------------------------------------------------------

app.get("/api/pump/command", requireDeviceAuth, (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  touchDevice(deviceId);

  const commandId = pendingCommandByDevice.get(deviceId);
  if (!commandId) return res.status(204).send();

  const command = commands.get(commandId);
  if (!command || command.status !== "PENDING") {
    pendingCommandByDevice.delete(deviceId);
    return res.status(204).send();
  }

  command.lastDeliveredAt = new Date().toISOString();
  command.deliveryCount += 1;

  return res.json({
    command: {
      id: command.id,
      action: command.action,
      ...(command.action === "START" ? { durationSec: command.durationSec } : {}),
    },
  });
});

// -----------------------------------------------------------------------------
// ESP32 -> Backend: command execution result
// Expected body: { deviceId, commandId, status, pumpState, message }
// -----------------------------------------------------------------------------

app.post("/api/pump/result", requireDeviceAuth, (req, res) => {
  const deviceId = requireDeviceId(req.body.deviceId);
  const commandId = requireNonEmptyString(req.body.commandId, "commandId", 100);
  const status = requireEnum(req.body.status, "status", [
    "STARTED", "STOPPED", "COMPLETED", "REJECTED", "FAILED",
  ]);
  const pumpState = requireEnum(req.body.pumpState, "pumpState", ["ON", "OFF"]);
  const message = optionalString(req.body.message, "message", 500);

  const command = commands.get(commandId);
  if (!command) {
    throw apiError(404, "COMMAND_NOT_FOUND", `Command '${commandId}' does not exist`);
  }
  if (command.deviceId !== deviceId) {
    throw apiError(409, "DEVICE_MISMATCH", "Command does not belong to this device");
  }

  const timestamp = new Date().toISOString();
  command.status = status;
  command.updatedAt = timestamp;
  command.result = { status, pumpState, message, timestamp };

  if (pendingCommandByDevice.get(deviceId) === commandId) {
    pendingCommandByDevice.delete(deviceId);
  }

  touchDevice(deviceId, {
    pumpState,
    latestCommandResult: { commandId, status, pumpState, message, timestamp },
  });

  res.json({ message: "Command result recorded", command: toPublicCommand(command) });
});

// -----------------------------------------------------------------------------
// Frontend -> Backend: manual START / STOP command
// Expected body: { deviceId, action, durationSec? }
// -----------------------------------------------------------------------------

app.post("/api/pump", (req, res) => {
  const deviceId = requireDeviceId(req.body.deviceId);
  const action = requireEnum(req.body.action, "action", ["START", "STOP"]);
  const durationSec = action === "START"
    ? requireInteger(req.body.durationSec, "durationSec", 1, CONFIG.maxPumpDurationSec)
    : undefined;

  const command = queuePumpCommand(deviceId, action, durationSec, "MANUAL");
  res.status(202).json({
    message: `${action} command queued`,
    command: toPublicCommand(command),
  });
});

// -----------------------------------------------------------------------------
// Frontend: dashboard, history, and command status
// -----------------------------------------------------------------------------

app.get("/api/latest", (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  const device = getDeviceStatus(deviceId);
  const latestReading = device.latestReading || findLatestReading(deviceId);

  res.json({
    deviceId,
    online: device.online,
    lastSeen: device.lastSeen,
    pumpState: device.pumpState || latestReading?.pumpState || "UNKNOWN",
    latestReading: latestReading || null,
    latestCommandResult: device.latestCommandResult || null,
  });
});

app.get("/api/device/status", (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  const device = getDeviceStatus(deviceId);
  res.json({
    deviceId,
    online: device.online,
    lastSeen: device.lastSeen,
    pumpState: device.pumpState || "UNKNOWN",
    latestCommandResult: device.latestCommandResult || null,
  });
});

app.get("/api/history", (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  const limit = req.query.limit === undefined
    ? 25
    : requireInteger(req.query.limit, "limit", 1, 500);
  const readings = loadReadings()
    .filter((reading) => reading.deviceId === deviceId)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);

  res.json({ deviceId, count: readings.length, limit, readings });
});

app.get("/api/pump/status", (req, res) => {
  const deviceId = requireDeviceId(req.query.deviceId);
  const pendingId = pendingCommandByDevice.get(deviceId);
  const pendingCommand = pendingId ? commands.get(pendingId) : null;
  const device = getDeviceStatus(deviceId);

  res.json({
    deviceId,
    online: device.online,
    pumpState: device.pumpState || "UNKNOWN",
    pendingCommand: pendingCommand ? toPublicCommand(pendingCommand) : null,
    latestCommandResult: device.latestCommandResult || null,
    maxPumpDurationSec: CONFIG.maxPumpDurationSec,
    autoWater: toPublicAutoWater(getAutoWaterSettings(deviceId)),
  });
});

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.originalUrl} was not found` },
  });
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({
      error: { code: "INVALID_JSON", message: "Request body contains invalid JSON" },
    });
  }
  if (err?.message?.startsWith("Origin not allowed by CORS")) {
    return res.status(403).json({ error: { code: "CORS_FORBIDDEN", message: err.message } });
  }

  const status = err.status || 500;
  const code = err.code || "INTERNAL_ERROR";
  if (status >= 500) console.error(err);
  return res.status(status).json({
    error: { code, message: status >= 500 ? "Unexpected server error" : err.message },
  });
});

app.listen(CONFIG.port, () => {
  console.log(`Smart Plant backend listening on port ${CONFIG.port}`);
  console.log(`Calibration: wet=${CONFIG.moistureRawWet}, dry=${CONFIG.moistureRawDry}`);
  console.log(`Max pump duration: ${CONFIG.maxPumpDurationSec}s`);
});

// -----------------------------------------------------------------------------
// Domain helpers
// -----------------------------------------------------------------------------

function evaluateAutoWatering(deviceId, reading) {
  const settings = getAutoWaterSettings(deviceId);
  const rearmAt = settings.thresholdPercent + settings.hysteresisPercent;

  // A successful wet reading arms the next watering cycle.
  if (reading.moisturePercentage >= rearmAt) {
    settings.armed = true;
    return;
  }

  if (!settings.enabled || !settings.armed) return;
  if (reading.moisturePercentage >= settings.thresholdPercent) return;
  if (reading.pumpState === "ON" || pendingCommandByDevice.has(deviceId)) return;

  const lastAutoWaterMs = settings.lastAutoWaterAt ? Date.parse(settings.lastAutoWaterAt) : NaN;
  if (Number.isFinite(lastAutoWaterMs) && Date.now() - lastAutoWaterMs < settings.cooldownMs) {
    return;
  }

  const command = queuePumpCommand(deviceId, "START", settings.durationSec, "AUTO");
  settings.lastAutoWaterAt = command.createdAt;
  settings.armed = false;
}

function queuePumpCommand(deviceId, action, durationSec, source) {
  const device = getDeviceStatus(deviceId);
  if (!device.online) {
    throw apiError(
      409,
      "DEVICE_OFFLINE",
      "Device is offline. Pump command was not queued to avoid delayed unexpected execution."
    );
  }

  const pendingId = pendingCommandByDevice.get(deviceId);
  if (pendingId) {
    const pending = commands.get(pendingId);
    if (action !== "STOP") {
      throw apiError(409, "COMMAND_PENDING", "Another pump command is still pending for this device");
    }
    if (pending) {
      pending.status = "CANCELLED";
      pending.updatedAt = new Date().toISOString();
    }
    pendingCommandByDevice.delete(deviceId);
  }

  const now = new Date().toISOString();
  const command = {
    id: crypto.randomUUID(),
    deviceId,
    action,
    ...(action === "START" ? { durationSec } : {}),
    source,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
    lastDeliveredAt: null,
    deliveryCount: 0,
    result: null,
  };
  commands.set(command.id, command);
  pendingCommandByDevice.set(deviceId, command.id);
  return command;
}

function getAutoWaterSettings(deviceId) {
  if (!autoWaterByDevice.has(deviceId)) {
    autoWaterByDevice.set(deviceId, {
      enabled: CONFIG.autoWaterEnabled,
      thresholdPercent: CONFIG.autoWaterThresholdPercent,
      durationSec: Math.min(CONFIG.autoWaterDurationSec, CONFIG.maxPumpDurationSec),
      cooldownMs: CONFIG.autoWaterCooldownMs,
      hysteresisPercent: CONFIG.autoWaterHysteresisPercent,
      lastAutoWaterAt: null,
      armed: true,
    });
  }
  return autoWaterByDevice.get(deviceId);
}

function toPublicAutoWater(settings) {
  return {
    enabled: settings.enabled,
    thresholdPercent: settings.thresholdPercent,
    durationSec: settings.durationSec,
    cooldownMinutes: settings.cooldownMs / 60_000,
    hysteresisPercent: settings.hysteresisPercent,
    lastAutoWaterAt: settings.lastAutoWaterAt,
    armed: settings.armed,
  };
}

function calculateMoisturePercentage(rawValue) {
  const percentage = ((CONFIG.moistureRawDry - rawValue)
    / (CONFIG.moistureRawDry - CONFIG.moistureRawWet)) * 100;
  return Math.round(clamp(percentage, 0, 100) * 10) / 10;
}

function determineSoilCondition(percentage) {
  if (percentage <= CONFIG.soilDryMaxPercent) return "DRY";
  if (percentage <= CONFIG.soilMoistMaxPercent) return "MOIST";
  return "WET";
}

function touchDevice(deviceId, patch = {}) {
  const current = devices.get(deviceId) || {};
  devices.set(deviceId, { ...current, ...patch, deviceId, lastSeen: new Date().toISOString() });
}

function getDeviceStatus(deviceId) {
  const device = devices.get(deviceId) || {};
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : NaN;
  return {
    ...device,
    deviceId,
    online: Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= CONFIG.onlineTimeoutMs,
  };
}

function appendReading(reading) {
  const readings = loadReadings();
  readings.push(reading);
  writeReadings(readings);
}

function findLatestReading(deviceId) {
  return loadReadings()
    .filter((reading) => reading.deviceId === deviceId)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] || null;
}

function loadReadings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.readingsFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("readings.json must contain an array");
    return parsed;
  } catch (error) {
    console.error("Could not read readings file:", error.message);
    throw apiError(500, "READINGS_STORAGE_ERROR", "Could not read readings storage");
  }
}

function writeReadings(readings) {
  const tempFile = `${CONFIG.readingsFile}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(readings, null, 2), "utf8");
    fs.renameSync(tempFile, CONFIG.readingsFile);
  } catch (error) {
    console.error("Could not write readings file:", error.message);
    throw apiError(500, "READINGS_STORAGE_ERROR", "Could not write readings storage");
  }
}

function ensureReadingsFile() {
  fs.mkdirSync(path.dirname(CONFIG.readingsFile), { recursive: true });
  if (!fs.existsSync(CONFIG.readingsFile)) fs.writeFileSync(CONFIG.readingsFile, "[]\n", "utf8");
}

function requireDeviceAuth(req, _res, next) {
  if (!CONFIG.deviceApiKey || req.get("X-Device-Key") === CONFIG.deviceApiKey) return next();
  return next(apiError(401, "DEVICE_UNAUTHORIZED", "Invalid or missing X-Device-Key"));
}

function toPublicCommand(command) {
  return {
    id: command.id,
    deviceId: command.deviceId,
    action: command.action,
    ...(command.action === "START" ? { durationSec: command.durationSec } : {}),
    source: command.source || "MANUAL",
    status: command.status,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
    result: command.result,
  };
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function requireDeviceId(value) {
  const deviceId = requireNonEmptyString(value, "deviceId", 80);
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) {
    throw apiError(400, "INVALID_DEVICE_ID", "deviceId contains unsupported characters");
  }
  return deviceId;
}

function requireInteger(value, field, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw apiError(400, "INVALID_FIELD", `${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function requireNumber(value, field, min, max) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(number) || number < min || number > max) {
    throw apiError(400, "INVALID_FIELD", `${field} must be a number between ${min} and ${max}`);
  }
  return number;
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw apiError(400, "INVALID_FIELD", `${field} must be true or false`);
  }
  return value;
}

function requireEnum(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw apiError(400, "INVALID_FIELD", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function requireNonEmptyString(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw apiError(400, "INVALID_FIELD", `${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function optionalString(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw apiError(400, "INVALID_FIELD", `${field} must be a string up to ${maxLength} characters`);
  }
  return value;
}

function readIntegerEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readNumberEnv(name, fallback, min, max) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function readBooleanEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  if (process.env[name] === "true") return true;
  if (process.env[name] === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readCsvEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  return process.env[name].split(",").map((item) => item.trim()).filter(Boolean);
}

function validateConfiguration() {
  if (CONFIG.moistureRawWet === CONFIG.moistureRawDry) {
    throw new Error("MOISTURE_RAW_WET and MOISTURE_RAW_DRY must be different");
  }
  if (CONFIG.soilDryMaxPercent >= CONFIG.soilMoistMaxPercent) {
    throw new Error("SOIL_DRY_MAX_PERCENT must be lower than SOIL_MOIST_MAX_PERCENT");
  }
  if (CONFIG.autoWaterThresholdPercent + CONFIG.autoWaterHysteresisPercent > 100) {
    throw new Error("AUTO_WATER_THRESHOLD_PERCENT + AUTO_WATER_HYSTERESIS_PERCENT must not exceed 100");
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function apiError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
