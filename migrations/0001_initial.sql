CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(tenant_id, name)
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(city_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  city_id TEXT REFERENCES cities(id) ON DELETE SET NULL,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('MEMBER','OPERATOR','ADMIN','OWNER')) DEFAULT 'MEMBER',
  email_verified_at TEXT,
  disabled_at TEXT,
  totp_secret_enc TEXT,
  totp_pending_enc TEXT,
  totp_pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  mfa_verified INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN','OWNER')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  city_id TEXT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ESP32_CONTROLLER','ESP8266_SENDER')),
  api_key_hash TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  current_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  barrier_state TEXT NOT NULL DEFAULT 'DOWN',
  barrier_latched INTEGER NOT NULL DEFAULT 0,
  emergency_stop_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level_cm REAL NOT NULL,
  rainfall_mm REAL,
  state TEXT NOT NULL CHECK(state IN ('SAFE','WATCH','WARNING','CRITICAL','UNKNOWN','FAULT')),
  barrier_state TEXT NOT NULL DEFAULT 'DOWN',
  sensor_healthy INTEGER NOT NULL DEFAULT 1,
  battery_mv INTEGER,
  rssi INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, seq)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE CASCADE,
  email TEXT,
  phone TEXT,
  push_endpoint TEXT UNIQUE,
  push_p256dh TEXT,
  push_auth TEXT,
  consent_at TEXT NOT NULL,
  verified_at TEXT,
  verification_token_hash TEXT,
  unsubscribe_token_hash TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS','WEB_PUSH')),
  recipient TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SENT','RETRYING','DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_configs (
  provider TEXT PRIMARY KEY CHECK(provider IN ('SMTP','SMS_HTTP')),
  config_cipher TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  last_test_at TEXT,
  last_test_status TEXT
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS firmware_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  asset_url TEXT,
  channel TEXT NOT NULL DEFAULT 'stable',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  requested_by TEXT REFERENCES users(id),
  requested_at TEXT NOT NULL,
  acknowledged_at TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS content_revisions (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cities_tenant ON cities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_zones_city ON zones(city_id);
CREATE INDEX IF NOT EXISTS idx_users_scope ON users(tenant_id, city_id, zone_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_email_expiry ON admin_invites(email, expires_at);
CREATE INDEX IF NOT EXISTS idx_devices_scope ON devices(tenant_id, city_id, zone_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_created ON telemetry(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_scope ON subscriptions(tenant_id, zone_id, verified_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_slug_locale_status ON content_revisions(slug, locale, status);
