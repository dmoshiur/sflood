-- Flood engine, device command channel, service areas, ops access and account extensions.

-- 1. users: profile, notification preferences, email verification tokens.
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;
ALTER TABLE users ADD COLUMN country TEXT;
ALTER TABLE users ADD COLUMN city_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN notification_prefs_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE users ADD COLUMN email_verification_expires_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;

-- 2. devices: approval workflow, provisioning, health/fault metadata.
ALTER TABLE devices ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE devices ADD COLUMN approved_at TEXT;
ALTER TABLE devices ADD COLUMN approved_by TEXT;
ALTER TABLE devices ADD COLUMN provisioning_token_hash TEXT;
ALTER TABLE devices ADD COLUMN provisioning_expires_at TEXT;
ALTER TABLE devices ADD COLUMN limit_switch_state TEXT;
ALTER TABLE devices ADD COLUMN fault_state TEXT;
ALTER TABLE devices ADD COLUMN uptime_s INTEGER;
ALTER TABLE devices ADD COLUMN rate_of_rise_cm_min REAL;
ALTER TABLE devices ADD COLUMN last_rssi INTEGER;
ALTER TABLE devices ADD COLUMN public_uid TEXT;

-- 3. telemetry: widened state vocabulary (NORMAL / RECOVERY) plus richer sensor fields.
CREATE TABLE telemetry_rebuild (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level_cm REAL NOT NULL,
  rainfall_mm REAL,
  rate_of_rise_cm_min REAL,
  state TEXT NOT NULL CHECK(state IN ('SAFE','NORMAL','WATCH','WARNING','CRITICAL','RECOVERY','UNKNOWN','FAULT')),
  barrier_state TEXT NOT NULL DEFAULT 'DOWN',
  limit_switch_state TEXT,
  sensor_healthy INTEGER NOT NULL DEFAULT 1,
  battery_mv INTEGER,
  rssi INTEGER,
  uptime_s INTEGER,
  firmware_version TEXT,
  fault_state TEXT,
  reported_at TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, seq)
);
INSERT INTO telemetry_rebuild(id,device_id,seq,level_cm,rainfall_mm,rate_of_rise_cm_min,state,barrier_state,limit_switch_state,sensor_healthy,battery_mv,rssi,uptime_s,firmware_version,fault_state,reported_at,received_at,created_at)
  SELECT id,device_id,seq,level_cm,rainfall_mm,NULL,state,barrier_state,NULL,sensor_healthy,battery_mv,rssi,NULL,NULL,NULL,created_at,created_at,created_at FROM telemetry;
DROP TABLE telemetry;
ALTER TABLE telemetry_rebuild RENAME TO telemetry;
CREATE INDEX idx_telemetry_device_created ON telemetry(device_id, created_at);

-- 4. flood_events: persisted engine transitions (including suppressed-marker rows).
CREATE TABLE IF NOT EXISTS flood_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  state TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('INFO','WARNING','CRITICAL','RECOVERY')),
  level_cm REAL,
  rate_of_rise_cm_min REAL,
  reason TEXT NOT NULL,
  duplicate_suppressed INTEGER NOT NULL DEFAULT 0,
  simulation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flood_events_tenant_created ON flood_events(tenant_id, created_at);

-- 5. barrier_commands: remote command channel with command id, nonce, expiry and replay protection.
CREATE TABLE IF NOT EXISTS barrier_commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('BARRIER_RAISE','BARRIER_LOWER','BARRIER_HOLD','HEALTH_CHECK','SYNC_TIME')),
  nonce_hash TEXT NOT NULL UNIQUE,
  sealed_nonce TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','DELIVERED','ACKNOWLEDGED','EXPIRED','CANCELED','FAILED')),
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  ack_nonce_hash TEXT,
  result TEXT,
  limit_switch_state TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_barrier_commands_device_status ON barrier_commands(device_id, status);

-- 6. device_credentials: per-device key rotation history (active key stays on devices.api_key_hash).
CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'primary',
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id, revoked_at);

-- 7. service_areas: registration allowlist of cities/countries.
CREATE TABLE IF NOT EXISTS service_areas (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  city_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(country_code, city_name)
);

-- 8. ops_credentials: rotating operations access delivered hourly by email (hash only at rest).
CREATE TABLE IF NOT EXISTS ops_credentials (
  id TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'PENDING',
  delivered_to TEXT,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

-- 9. in_app_notifications: notification center rows for signed-in users.
CREATE TABLE IF NOT EXISTS in_app_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('FLOOD_EVENT','DEVICE','SYSTEM','COMMAND','ACCOUNT')),
  severity TEXT NOT NULL CHECK(severity IN ('INFO','WARNING','CRITICAL','RECOVERY')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_in_app_user_created ON in_app_notifications(user_id, created_at);

-- 10. maintenance_events: maintenance mode + emergency site status history.
CREATE TABLE IF NOT EXISTS maintenance_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('MAINTENANCE_ON','MAINTENANCE_OFF','EMERGENCY_ON','EMERGENCY_OFF')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
