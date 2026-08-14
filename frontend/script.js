const { config, apiFetch, formatDateTime, setText, setBadge, soilTone, setConnectionMessage } = App;

let refreshTimer;

document.addEventListener("DOMContentLoaded", () => {
  setText("sidebarDeviceId", config.DEVICE_ID);
  setText("detailDeviceId", config.DEVICE_ID);
  document.getElementById("refreshButton").addEventListener("click", loadDashboard);
  loadDashboard();
  refreshTimer = setInterval(loadDashboard, config.DASHBOARD_REFRESH_MS);
});

window.addEventListener("beforeunload", () => clearInterval(refreshTimer));

async function loadDashboard() {
  try {
    const data = await apiFetch(`/api/latest?deviceId=${encodeURIComponent(config.DEVICE_ID)}`);
    renderDashboard(data);
    setConnectionMessage("");
  } catch (error) {
    setConnectionMessage(`Backend unavailable: ${error.message}`);
    renderOfflineFallback();
  }
}

function renderDashboard(data) {
  const reading = data.latestReading;

  setBadge(
    document.getElementById("deviceStatusBadge"),
    data.online ? "ONLINE" : "OFFLINE",
    data.online ? "success" : "danger"
  );
  setText("deviceStatusText", data.online ? "Receiving device heartbeat" : "No recent heartbeat");
  setText("lastSeen", formatDateTime(data.lastSeen));

  const pumpState = data.pumpState || "UNKNOWN";
  setBadge(
    document.getElementById("pumpStateBadge"),
    pumpState,
    pumpState === "ON" ? "warning" : pumpState === "OFF" ? "success" : "neutral"
  );
  setText("pumpStateText", pumpState === "ON" ? "Pump is running" : pumpState === "OFF" ? "Pump is stopped" : "Waiting for device");

  if (!reading) {
    clearReading();
    return;
  }

  setText("moistureRaw", reading.moistureRaw);
  setText("moisturePercentage", reading.moisturePercentage);
  setText("readingTime", formatDateTime(reading.timestamp));
  setText("detailMoisture", `${reading.moisturePercentage}% (${reading.moistureRaw} raw)`);
  setText("detailSoil", reading.soilCondition);
  setText("lastReadingText", `Last reading ${formatDateTime(reading.timestamp)}`);

  const bar = document.getElementById("moistureBar");
  bar.style.width = `${Math.max(0, Math.min(100, reading.moisturePercentage))}%`;

  setBadge(
    document.getElementById("soilConditionBadge"),
    reading.soilCondition,
    soilTone(reading.soilCondition)
  );
}

function clearReading() {
  setText("moistureRaw", "—");
  setText("moisturePercentage", "—");
  setText("readingTime", "—");
  setText("detailMoisture", "—");
  setText("detailSoil", "—");
  setText("lastReadingText", "Waiting for the first reading…");
  document.getElementById("moistureBar").style.width = "0%";
  setBadge(document.getElementById("soilConditionBadge"), "UNKNOWN", "neutral");
}

function renderOfflineFallback() {
  setBadge(document.getElementById("deviceStatusBadge"), "UNKNOWN", "neutral");
  setText("deviceStatusText", "Backend connection unavailable");
}
