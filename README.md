# Smart Plant Watering

A small ESP32 + Node.js + static frontend project. The frontend never connects directly to the ESP32; both communicate through the backend.

## Pages

- `frontend/index.html` — dashboard
- `frontend/control.html` — pump control
- `frontend/history.html` — sensor history

## ESP32-compatible API contract

The backend matches the previously generated ESP32 code:

- `POST /api/readings`
- `GET /api/pump/command?deviceId=esp32-plant-01`
- `POST /api/pump/result`

Frontend endpoints:

- `GET /api/latest?deviceId=...`
- `GET /api/device/status?deviceId=...`
- `GET /api/history?deviceId=...&limit=25`
- `POST /api/pump`
- `GET /api/pump/status?deviceId=...`
- `GET /api/config`

## Local setup

### 1. Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Backend default URL: `http://localhost:3000`

### 2. Frontend

Serve the `frontend` directory with any static HTTP server. Example with VS Code Live Server, or:

```bash
cd frontend
python3 -m http.server 5500
```

Open `http://localhost:5500`.

### 3. ESP32

In the ESP32 `secrets.h`:

```cpp
#define API_BASE_URL "http://YOUR_COMPUTER_LAN_IP:3000"
#define DEVICE_API_KEY ""
```

Do not use `localhost` in ESP32 because `localhost` would mean the ESP32 itself.

For a deployed HTTPS backend, set `API_BASE_URL` to that public backend URL.

## Calibration

Calibration is outside business logic and can be changed in `backend/.env`:

```env
MOISTURE_RAW_WET=3000
MOISTURE_RAW_DRY=4000
SOIL_DRY_MAX_PERCENT=30
SOIL_MOIST_MAX_PERCENT=65
MAX_PUMP_DURATION_SEC=30
```

Moisture percentage is calculated by the backend and clamped to 0–100%.

## Security

- `backend/.env` is ignored by Git.
- `esp32/secrets.h` is ignored by Git.
- If `DEVICE_API_KEY` is configured in backend `.env`, put the same value in ESP32 `DEVICE_API_KEY`.
- The static frontend does not contain the device API key.

## Important deployment note

`readings.json` and in-memory command/device state are appropriate for a single-instance learning/demo deployment. Some cloud platforms use ephemeral filesystems or multiple instances. For production persistence, replace the JSON file and in-memory command state with a database.
