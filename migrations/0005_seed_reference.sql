-- Smart Flood Control & Automation - seed reference data.
-- Idempotent reference rows only. No users, devices or secrets are seeded.

INSERT OR IGNORE INTO tenants(id, name, slug, created_at)
VALUES ('tenant-floodgrid', 'FloodGrid Science Project', 'floodgrid', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO service_areas(id, tenant_id, city, region, country, country_code, latitude, longitude, enabled, requires_review, notes, created_at, updated_at)
VALUES
  ('sa-dhaka', 'tenant-floodgrid', 'Dhaka', 'Dhaka Division', 'Bangladesh', 'BD', 23.8103, 90.4125, 1, 0, 'Project home city - prototype tray model site.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-chattogram', 'tenant-floodgrid', 'Chattogram', 'Chattogram Division', 'Bangladesh', 'BD', 22.3569, 91.7832, 1, 0, 'Coastal surge monitoring interest.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-sylhet', 'tenant-floodgrid', 'Sylhet', 'Sylhet Division', 'Bangladesh', 'BD', 24.8949, 91.8687, 1, 0, 'Haor basin flash-flood monitoring interest.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-khulna', 'tenant-floodgrid', 'Khulna', 'Khulna Division', 'Bangladesh', 'BD', 22.8456, 89.5403, 1, 0, 'Tidal river monitoring interest.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-rangpur', 'tenant-floodgrid', 'Rangpur', 'Rangpur Division', 'Bangladesh', 'BD', 25.7439, 89.2752, 1, 0, 'Teesta basin monitoring interest.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-london', 'tenant-floodgrid', 'London', 'England', 'United Kingdom', 'GB', 51.5072, -0.1276, 1, 0, 'Thames tidal defence reference site.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-rotterdam', 'tenant-floodgrid', 'Rotterdam', 'South Holland', 'Netherlands', 'NL', 51.9244, 4.4777, 1, 0, 'Delta works reference site.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('sa-jakarta', 'tenant-floodgrid', 'Jakarta', 'Jakarta', 'Indonesia', 'ID', -6.2088, 106.8456, 1, 0, 'Coastal subsidence reference site.', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO cities(id, tenant_id, name, created_at)
VALUES
  ('city-dhaka', 'tenant-floodgrid', 'Dhaka', '2026-01-01T00:00:00.000Z'),
  ('city-london', 'tenant-floodgrid', 'London', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO zones(id, city_id, name, created_at)
VALUES
  ('zone-north-bank', 'city-dhaka', 'Ward 04 - North Bank', '2026-01-01T00:00:00.000Z'),
  ('zone-riverside', 'city-dhaka', 'Ward 07 - Riverside Embankment', '2026-01-01T00:00:00.000Z'),
  ('zone-thames', 'city-london', 'Thames Tidal Reach', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO flood_policies(id, tenant_id, zone_id, scope, name, normal_below_cm, watch_cm, warning_cm, critical_cm, rate_of_rise_cm_per_min, hysteresis_cm, recovery_cm, recovery_hold_seconds, cooldown_seconds, confirmation_samples, confirmation_window_seconds, auto_barrier_states, barrier_recovery_state, notify_channels, notify_recovery, enabled, created_at, updated_at)
VALUES
  ('policy-default', 'tenant-floodgrid', NULL, 'TENANT', 'Default FloodGrid policy', 18, 25, 40, 55, 6, 4, 20, 300, 120, 1, 180, 'WARNING,CRITICAL', 'RECOVERY', 'IN_APP,EMAIL,WEB_PUSH', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('policy-north-bank', 'tenant-floodgrid', 'zone-north-bank', 'ZONE', 'North Bank calibrated policy', 15, 22, 36, 50, 5, 3, 17, 300, 120, 2, 180, 'WARNING,CRITICAL', 'RECOVERY', 'IN_APP,EMAIL,WEB_PUSH,SMS', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO site_settings(key, value_json, updated_by, updated_at)
VALUES
  ('site_name', '"Smart Flood Control & Automation"', NULL, '2026-01-01T00:00:00.000Z'),
  ('maintenance_mode', 'false', NULL, '2026-01-01T00:00:00.000Z'),
  ('public_status_enabled', 'true', NULL, '2026-01-01T00:00:00.000Z'),
  ('simulation_enabled', 'true', NULL, '2026-01-01T00:00:00.000Z'),
  ('safety_notice', '"Educational prototype. Not a real flood defence or emergency warning service."', NULL, '2026-01-01T00:00:00.000Z'),
  ('safety_instructions', '["Move to higher ground and follow instructions from your local emergency authority.","Do not walk or drive through flood water.","Keep charged devices and a battery radio available.","Never rely on this prototype for life-safety decisions."]', NULL, '2026-01-01T00:00:00.000Z'),
  ('cloudinary_cloud_name', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('cloudinary_upload_preset', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('github_esp32_url', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('github_esp8266_url', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('github_releases_url', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('ops_email', '""', NULL, '2026-01-01T00:00:00.000Z'),
  ('ops_rotation_minutes', '60', NULL, '2026-01-01T00:00:00.000Z'),
  ('ops_require_mfa', 'true', NULL, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO feature_flags(key, value_json, description, updated_by, updated_at)
VALUES
  ('public_registration', 'true', 'Allow public account registration inside service areas.', NULL, '2026-01-01T00:00:00.000Z'),
  ('device_approval_required', 'true', 'New devices require admin approval before telemetry is accepted.', NULL, '2026-01-01T00:00:00.000Z'),
  ('mqtt_gateway_enabled', 'false', 'Bridge telemetry from an external MQTT broker when configured.', NULL, '2026-01-01T00:00:00.000Z'),
  ('sms_channel_enabled', 'false', 'Enable the SMS notification channel once a gateway is configured.', NULL, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO firmware_releases(id, version, sha256, size_bytes, asset_url, channel, notes, created_at, board, download_url, github_url, github_release_url, min_hardware_revision, published)
VALUES
  ('fw-esp32-1-4-0', '1.4.0', 'not-published-in-this-repository', 0, NULL, 'stable', 'ESP32 controller firmware: ultrasonic sensing, barrier state machine, limit switches, E-stop fail-safe, signed command polling.', '2026-01-01T00:00:00.000Z', 'ESP32', NULL, NULL, NULL, 'rev-b', 1),
  ('fw-esp8266-1-2-0', '1.2.0', 'not-published-in-this-repository', 0, NULL, 'stable', 'ESP8266 sender firmware: telemetry and heartbeat only, no actuator control.', '2026-01-01T00:00:00.000Z', 'ESP8266', NULL, NULL, NULL, 'rev-a', 1);
