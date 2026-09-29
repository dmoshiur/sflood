-- Notification templates and local-admin manual records.

CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS','WEB_PUSH','IN_APP')),
  state TEXT NOT NULL DEFAULT 'ANY',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, template_key, channel, state)
);

CREATE TABLE IF NOT EXISTS manual_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'OBSERVATION',
  level_cm REAL,
  note TEXT NOT NULL DEFAULT '',
  recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manual_records_zone ON manual_records(zone_id, created_at);

INSERT OR IGNORE INTO notification_templates(id, tenant_id, template_key, channel, state, subject, body, enabled, updated_at)
VALUES
  ('tpl-flood-critical-email', 'tenant-floodgrid', 'flood_transition', 'EMAIL', 'CRITICAL', '{{zone}}: CRITICAL water level', 'Water level {{level}} cm at {{device}}. {{reason}} This is an educational prototype and not an emergency warning.', 1, '2026-01-01T00:00:00.000Z'),
  ('tpl-flood-warning-push', 'tenant-floodgrid', 'flood_transition', 'WEB_PUSH', 'WARNING', '{{zone}}: WARNING water level', 'Water level {{level}} cm at {{device}}. {{reason}}', 1, '2026-01-01T00:00:00.000Z'),
  ('tpl-flood-recovery-email', 'tenant-floodgrid', 'flood_transition', 'EMAIL', 'RECOVERY', '{{zone}}: water level recovering', 'Water level has fallen to {{level}} cm at {{device}}. {{reason}}', 1, '2026-01-01T00:00:00.000Z'),
  ('tpl-command-inapp', 'tenant-floodgrid', 'barrier_command', 'IN_APP', 'ANY', 'Barrier command {{action}}', 'Command {{commandId}} for {{device}} was issued by {{actor}}. {{reason}}', 1, '2026-01-01T00:00:00.000Z');
