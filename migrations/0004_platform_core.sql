-- Smart Flood Control & Automation - platform core schema.
-- Adds the multi-user, multi-device, policy-driven flood platform on top of the
-- initial tenant/city/zone scaffolding.

CREATE TABLE IF NOT EXISTS service_areas (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  city TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL,
  country_code TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  requires_review INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, country_code, city, region)
);
CREATE INDEX IF NOT EXISTS idx_service_areas_lookup ON service_areas(tenant_id, country_code, city, enabled);

ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN avatar_public_id TEXT;
ALTER TABLE users ADD COLUMN service_area_id TEXT REFERENCES service_areas(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN notification_prefs_json TEXT;
ALTER TABLE users ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE users ADD COLUMN email_verification_expires_at TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;
ALTER TABLE users ADD COLUMN password_reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN password_reset_expires_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN password_updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_users_service_area ON users(service_area_id);

CREATE TABLE IF NOT EXISTS flood_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'ZONE',
  name TEXT NOT NULL,
  normal_below_cm REAL NOT NULL DEFAULT 18,
  watch_cm REAL NOT NULL DEFAULT 25,
  warning_cm REAL NOT NULL DEFAULT 40,
  critical_cm REAL NOT NULL DEFAULT 55,
  rate_of_rise_cm_per_min REAL NOT NULL DEFAULT 6,
  hysteresis_cm REAL NOT NULL DEFAULT 4,
  recovery_cm REAL NOT NULL DEFAULT 20,
  recovery_hold_seconds INTEGER NOT NULL DEFAULT 300,
  cooldown_seconds INTEGER NOT NULL DEFAULT 120,
  confirmation_samples INTEGER NOT NULL DEFAULT 1,
  confirmation_window_seconds INTEGER NOT NULL DEFAULT 180,
  auto_barrier_states TEXT NOT NULL DEFAULT 'WARNING,CRITICAL',
  barrier_recovery_state TEXT NOT NULL DEFAULT 'RECOVERY',
  notify_channels TEXT NOT NULL DEFAULT 'IN_APP,EMAIL,WEB_PUSH',
  notify_recovery INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flood_policies_scope ON flood_policies(tenant_id, zone_id, enabled);

CREATE TABLE IF NOT EXISTS flood_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  event_key TEXT NOT NULL UNIQUE,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  level_cm REAL,
  rate_cm_per_min REAL,
  trigger TEXT NOT NULL DEFAULT 'THRESHOLD',
  reason TEXT NOT NULL DEFAULT '',
  simulated INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flood_events_zone_created ON flood_events(zone_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flood_events_state ON flood_events(tenant_id, to_state, created_at);

CREATE TABLE IF NOT EXISTS barrier_commands (
  id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('RAISE','LOWER','HOLD','EMERGENCY_STOP','RESET_FAULT')),
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_kind TEXT NOT NULL DEFAULT 'USER',
  reason TEXT NOT NULL DEFAULT '',
  nonce TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','DELIVERED','ACKNOWLEDGED','FAILED','EXPIRED','CANCELLED','REJECTED')),
  ack_payload_json TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_barrier_commands_device_status ON barrier_commands(device_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_barrier_commands_nonce ON barrier_commands(nonce, issued_at);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'primary',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED','EXPIRED')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_device ON device_credentials(device_id, status);

CREATE TABLE IF NOT EXISTS device_provisioning (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  board TEXT NOT NULL DEFAULT 'ESP32',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_provisioning_token ON device_provisioning(token_hash, expires_at);

ALTER TABLE devices ADD COLUMN uid TEXT;
ALTER TABLE devices ADD COLUMN board TEXT NOT NULL DEFAULT 'ESP32';
ALTER TABLE devices ADD COLUMN approval_state TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE devices ADD COLUMN approval_note TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN approved_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN approved_at TEXT;
ALTER TABLE devices ADD COLUMN signal_dbm INTEGER;
ALTER TABLE devices ADD COLUMN uptime_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN fault_state TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE devices ADD COLUMN limit_switch_low INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN limit_switch_high INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE devices ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE devices ADD COLUMN heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 30;
ALTER TABLE devices ADD COLUMN simulation INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_uid ON devices(uid);

ALTER TABLE firmware_releases ADD COLUMN board TEXT NOT NULL DEFAULT 'ESP32';
ALTER TABLE firmware_releases ADD COLUMN download_url TEXT;
ALTER TABLE firmware_releases ADD COLUMN github_url TEXT;
ALTER TABLE firmware_releases ADD COLUMN github_release_url TEXT;
ALTER TABLE firmware_releases ADD COLUMN min_hardware_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE firmware_releases ADD COLUMN published INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  consent_at TEXT NOT NULL,
  last_used_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_zone ON push_subscriptions(zone_id, unsubscribed_at);

CREATE TABLE IF NOT EXISTS email_subscribers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  locale TEXT NOT NULL DEFAULT 'en',
  consent_at TEXT NOT NULL,
  verification_token_hash TEXT,
  verification_expires_at TEXT,
  verified_at TEXT,
  unsubscribe_token_hash TEXT,
  unsubscribed_at TEXT,
  source TEXT NOT NULL DEFAULT 'status-page',
  created_at TEXT NOT NULL,
  UNIQUE(zone_id, email)
);
CREATE INDEX IF NOT EXISTS idx_email_subscribers_lookup ON email_subscribers(zone_id, verified_at, unsubscribed_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled INTEGER NOT NULL DEFAULT 1,
  sms_enabled INTEGER NOT NULL DEFAULT 0,
  push_enabled INTEGER NOT NULL DEFAULT 1,
  in_app_enabled INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start INTEGER,
  quiet_hours_end INTEGER,
  min_severity TEXT NOT NULL DEFAULT 'WATCH',
  recovery_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'IN_APP',
  severity TEXT NOT NULL DEFAULT 'INFO',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '/app',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_zone ON notifications(zone_id, created_at);

CREATE TABLE IF NOT EXISTS maintenance_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_events_active ON maintenance_events(tenant_id, ended_at);

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_pages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  published_version_id TEXT,
  draft_json TEXT NOT NULL DEFAULT '{"blocks":[]}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, slug)
);

CREATE TABLE IF NOT EXISTS site_page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(page_id, version)
);
CREATE INDEX IF NOT EXISTS idx_site_page_versions_page ON site_page_versions(page_id, version);

CREATE TABLE IF NOT EXISTS ops_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'operations',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_ip TEXT,
  revoked_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_credentials_lookup ON ops_credentials(credential_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_ops_credentials_issued ON ops_credentials(issued_at);

CREATE TABLE IF NOT EXISTS ops_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ip_address TEXT,
  attempt_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_attempts_key ON ops_attempts(attempt_key, created_at);
