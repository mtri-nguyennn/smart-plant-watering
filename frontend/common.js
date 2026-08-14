const App = (() => {
  const config = window.APP_CONFIG;

  async function apiFetch(path, options = {}) {
    const response = await fetch(`${config.API_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (response.status === 204) return null;

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.error?.message || `Request failed with HTTP ${response.status}`;
      const error = new Error(message);
      error.code = payload?.error?.code || "HTTP_ERROR";
      error.status = response.status;
      throw error;
    }

    return payload;
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(date);
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value ?? "—";
  }

  function setBadge(element, text, tone = "neutral") {
    if (!element) return;
    element.textContent = text;
    element.className = `status-badge ${tone}`;
  }

  function soilTone(condition) {
    if (condition === "DRY") return "danger";
    if (condition === "MOIST") return "warning";
    if (condition === "WET") return "success";
    return "neutral";
  }

  function showToast(message, tone = "info") {
    const region = document.getElementById("toastRegion");
    if (!region) return;

    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.textContent = message;
    region.appendChild(toast);

    setTimeout(() => toast.remove(), 4200);
  }

  function setConnectionMessage(message = "") {
    const element = document.getElementById("connectionMessage");
    if (!element) return;
    element.textContent = message;
    element.hidden = !message;
  }

  return {
    config,
    apiFetch,
    formatDateTime,
    setText,
    setBadge,
    soilTone,
    showToast,
    setConnectionMessage,
  };
})();
