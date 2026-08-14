#ifndef CONFIG_H
#define CONFIG_H

// =====================================================
// DEVICE
// =====================================================
#define DEVICE_ID "esp32-plant-01"

// =====================================================
// HARDWARE
// =====================================================
#define SENSOR_PIN 34
#define PUMP_PIN   26

// Change to false if your relay/MOSFET is active LOW
#define PUMP_ACTIVE_HIGH true

// =====================================================
// TIMING
// =====================================================

// Send moisture reading every 10 seconds
#define SENSOR_REPORT_INTERVAL_MS 10000UL

// Ask backend for pump command every 1 second
#define COMMAND_POLL_INTERVAL_MS 1000UL

// WiFi retry
#define WIFI_RETRY_INTERVAL_MS 5000UL

// HTTP timeout
#define HTTP_TIMEOUT_MS 5000

// =====================================================
// PUMP SAFETY
// =====================================================

// Hardware-side protection.
// Backend should ALSO enforce its own maximum.
#define MAX_PUMP_DURATION_SEC 30

#endif