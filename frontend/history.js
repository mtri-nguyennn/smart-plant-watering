const { config, apiFetch, formatDateTime, soilTone, setText, setConnectionMessage } = App;

document.addEventListener("DOMContentLoaded", () => {
  setText("sidebarDeviceId", config.DEVICE_ID);
  document.getElementById("refreshButton").addEventListener("click", loadHistory);
  document.getElementById("limitSelect").addEventListener("change", loadHistory);
  loadHistory();
});

async function loadHistory() {
  const limit = Number(document.getElementById("limitSelect").value);
  try {
    const data = await apiFetch(`/api/history?deviceId=${encodeURIComponent(config.DEVICE_ID)}&limit=${limit}`);
    renderRows(data.readings);
    setText("historySummary", `Showing ${data.count} newest reading${data.count === 1 ? "" : "s"}.`);
    setConnectionMessage("");
  } catch (error) {
    setConnectionMessage(`Could not load history: ${error.message}`);
    renderRows([]);
  }
}

function renderRows(readings) {
  const body = document.getElementById("historyBody");
  body.innerHTML = "";

  if (!readings.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-cell">No readings found for this device.</td></tr>';
    return;
  }

  readings.forEach((reading) => {
    const row = document.createElement("tr");
    row.appendChild(cell(formatDateTime(reading.timestamp)));
    row.appendChild(cell(String(reading.moistureRaw)));
    row.appendChild(cell(`${reading.moisturePercentage}%`));
    row.appendChild(badgeCell(reading.soilCondition, soilTone(reading.soilCondition)));
    row.appendChild(badgeCell(reading.pumpState, reading.pumpState === "ON" ? "warning" : "success"));
    body.appendChild(row);
  });
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function badgeCell(text, tone) {
  const td = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `status-badge ${tone}`;
  badge.textContent = text;
  td.appendChild(badge);
  return td;
}
