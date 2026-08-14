const { config, apiFetch, formatDateTime, setText, setBadge, showToast, setConnectionMessage } = App;

let maxPumpDurationSec = 30;
let refreshTimer;

document.addEventListener("DOMContentLoaded", async () => {
  setText("sidebarDeviceId", config.DEVICE_ID);
  setText("deviceId", config.DEVICE_ID);

  document.getElementById("startButton").addEventListener("click", startPump);
  document.getElementById("stopButton").addEventListener("click", stopPump);
  document.getElementById("saveAutoWaterButton").addEventListener("click", saveAutoWater);
  document.getElementById("autoWaterThreshold").addEventListener("input", syncHysteresisLimit);

  await loadConfig();
  await loadAutoWater();
  await refreshStatus();
  refreshTimer = setInterval(refreshStatus, config.CONTROL_REFRESH_MS);
});

window.addEventListener("beforeunload", () => clearInterval(refreshTimer));

async function loadConfig() {
  try {
    const data = await apiFetch("/api/config");
    maxPumpDurationSec = data.maxPumpDurationSec;
    const input = document.getElementById("durationInput");
    input.max = String(maxPumpDurationSec);
    if (Number(input.value) > maxPumpDurationSec) input.value = String(maxPumpDurationSec);
    document.getElementById("autoWaterDuration").max = String(maxPumpDurationSec);
    setText("durationHint", `Allowed range: 1–${maxPumpDurationSec} seconds.`);
    renderPresets();
  } catch (error) {
    showToast(`Could not load backend safety config: ${error.message}`, "error");
  }
}

async function loadAutoWater() {
  try {
    const data = await apiFetch(`/api/auto-water?deviceId=${encodeURIComponent(config.DEVICE_ID)}`);
    document.getElementById("autoWaterEnabled").checked = data.enabled;
    document.getElementById("autoWaterThreshold").value = String(data.thresholdPercent);
    document.getElementById("autoWaterDuration").value = String(data.durationSec);
    document.getElementById("autoWaterCooldown").value = String(data.cooldownMinutes);
    document.getElementById("autoWaterHysteresis").value = String(data.hysteresisPercent);
    syncHysteresisLimit();
    renderAutoWaterStatus(data);
  } catch (error) {
    showToast(`Could not load automatic watering settings: ${error.message}`, "error");
    setText("autoWaterStatus", "Automatic watering settings are unavailable.");
  }
}

function syncHysteresisLimit() {
  const threshold = Number(document.getElementById("autoWaterThreshold").value);
  const hysteresisInput = document.getElementById("autoWaterHysteresis");
  const maxHysteresis = Number.isFinite(threshold) ? Math.max(0, 100 - threshold) : 100;
  hysteresisInput.max = String(maxHysteresis);

  if (Number(hysteresisInput.value) > maxHysteresis) {
    hysteresisInput.value = String(maxHysteresis);
  }
}

async function saveAutoWater() {
  const settings = {
    deviceId: config.DEVICE_ID,
    enabled: document.getElementById("autoWaterEnabled").checked,
    thresholdPercent: Number(document.getElementById("autoWaterThreshold").value),
    durationSec: Number(document.getElementById("autoWaterDuration").value),
    cooldownMinutes: Number(document.getElementById("autoWaterCooldown").value),
    hysteresisPercent: Number(document.getElementById("autoWaterHysteresis").value),
  };

  if (
    !Number.isFinite(settings.thresholdPercent) || settings.thresholdPercent < 0 || settings.thresholdPercent > 100 ||
    !Number.isInteger(settings.durationSec) || settings.durationSec < 1 || settings.durationSec > maxPumpDurationSec ||
    !Number.isInteger(settings.cooldownMinutes) || settings.cooldownMinutes < 1 || settings.cooldownMinutes > 1440 ||
    !Number.isFinite(settings.hysteresisPercent) || settings.hysteresisPercent < 0 || settings.hysteresisPercent > 100
  ) {
    showToast(`Check the automatic watering values. Duration must be 1–${maxPumpDurationSec} seconds.`, "error");
    return;
  }

  if (settings.thresholdPercent + settings.hysteresisPercent > 100) {
    showToast("Threshold plus hysteresis must not exceed 100%.", "error");
    return;
  }

  const button = document.getElementById("saveAutoWaterButton");
  button.disabled = true;
  try {
    const result = await apiFetch("/api/auto-water", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    renderAutoWaterStatus(result);
    showToast(result.message, "success");
    await refreshStatus();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderAutoWaterStatus(data) {
  if (!data.enabled) {
    setText("autoWaterStatus", "Automatic watering is disabled.");
    return;
  }

  const state = data.armed
    ? `Armed: will water below ${data.thresholdPercent}%.`
    : `Waiting for soil to reach ${data.thresholdPercent + data.hysteresisPercent}% before re-arming.`;
  setText(
    "autoWaterStatus",
    `${state} Runs ${data.durationSec}s with a ${data.cooldownMinutes}-minute cooldown.`
  );
}

function renderPresets() {
  const container = document.getElementById("presetButtons");
  container.innerHTML = "";
  const candidates = [5, 10, 15, 30, maxPumpDurationSec];
  [...new Set(candidates.filter((value) => value <= maxPumpDurationSec))].sort((a, b) => a - b).forEach((seconds) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip-button";
    button.textContent = `${seconds}s`;
    button.addEventListener("click", () => {
      document.getElementById("durationInput").value = String(seconds);
    });
    container.appendChild(button);
  });
}

async function startPump() {
  const durationSec = Number(document.getElementById("durationInput").value);
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > maxPumpDurationSec) {
    showToast(`Duration must be an integer from 1 to ${maxPumpDurationSec} seconds.`, "error");
    return;
  }

  await sendCommand({ deviceId: config.DEVICE_ID, action: "START", durationSec });
}

async function stopPump() {
  await sendCommand({ deviceId: config.DEVICE_ID, action: "STOP" });
}

async function sendCommand(body) {
  setButtonsDisabled(true);
  try {
    const result = await apiFetch("/api/pump", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showToast(result.message, "success");
    await refreshStatus();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setButtonsDisabled(false);
  }
}

async function refreshStatus() {
  try {
    const data = await apiFetch(`/api/pump/status?deviceId=${encodeURIComponent(config.DEVICE_ID)}`);
    renderStatus(data);
    setConnectionMessage("");
  } catch (error) {
    setConnectionMessage(`Backend unavailable: ${error.message}`);
  }
}

function renderStatus(data) {
  setBadge(
    document.getElementById("deviceStatusBadge"),
    data.online ? "ONLINE" : "OFFLINE",
    data.online ? "success" : "danger"
  );
  setText("deviceState", data.online ? "Online" : "Offline");

  const pumpState = data.pumpState || "UNKNOWN";
  setBadge(
    document.getElementById("pumpStateBadge"),
    pumpState,
    pumpState === "ON" ? "warning" : pumpState === "OFF" ? "success" : "neutral"
  );
  setText("pumpState", pumpState);

  if (data.autoWater) renderAutoWaterStatus(data.autoWater);

  if (data.pendingCommand) {
    const pending = data.pendingCommand;
    const detail = pending.action === "START" ? `${pending.action} · ${pending.durationSec}s` : pending.action;
    setText("pendingCommand", `${detail} (${pending.status})`);
  } else {
    setText("pendingCommand", "None");
  }

  if (data.latestCommandResult) {
    const result = data.latestCommandResult;
    setText("lastResult", `${result.status}${result.message ? ` — ${result.message}` : ""}`);
    setText("lastResultTime", formatDateTime(result.timestamp));
  } else {
    setText("lastResult", "—");
    setText("lastResultTime", "—");
  }

  document.getElementById("startButton").disabled = !data.online;
  document.getElementById("stopButton").disabled = !data.online;
}

function setButtonsDisabled(disabled) {
  document.getElementById("startButton").disabled = disabled;
  document.getElementById("stopButton").disabled = disabled;
}
