-- Notification delivery pipeline and public page seed.
-- notification_deliveries replaces the original outbox_events table so that the
-- in-app channel, provider message ids and retry bookkeeping are first class.

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  event_id TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('EMAIL','SMS','WEB_PUSH','IN_APP')),
  recipient TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','SENT','RETRYING','DEAD_LETTER','SKIPPED')),
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  provider_message_id TEXT,
  failure_reason TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_queue ON notification_deliveries(status, priority, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON notification_deliveries(event_id, channel);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_dedupe ON notification_deliveries(channel, recipient, event_id);

-- Published landing page blocks for the schema-driven site builder.
INSERT OR IGNORE INTO site_pages(id, tenant_id, slug, title, status, published_version_id, draft_json, created_at, updated_at)
VALUES ('page-home', 'tenant-floodgrid', 'home', 'Smart Flood Control & Automation', 'PUBLISHED', 'version-home-1',
 '{"blocks":[]}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO site_page_versions(id, page_id, version, title, blocks_json, note, created_by, created_at, published_at)
VALUES ('version-home-1', 'page-home', 1, 'Smart Flood Control & Automation',
 '[{"id":"hero-1","type":"hero","variant":"science","eyebrow":"Science-fair engineering project","title":"Smart Flood Control & Automation","subtitle":"A raised miniature city, ultrasonic water-level sensing, ESP32 controllers and an automated perimeter barrier, with a live command centre.","primaryAction":{"label":"Open live status","href":"/status"},"secondaryAction":{"label":"How it works","href":"/how-it-works"}},{"id":"text-1","type":"text","title":"The prototype city","body":"The physical model is a raised island city surrounded by a water tray. Sensor nodes measure the water level around the perimeter, an ESP32 controller runs the flood state machine locally, and a lightweight barrier rises before the water reaches the first building. The web platform is the command centre: it stores telemetry, evaluates the flood policy, records events, fans out notifications and commands the barrier."},{"id":"cards-1","type":"cards","title":"How the system fits together","items":[{"title":"Sense","body":"Ultrasonic distance sensors on ESP32 and ESP8266 nodes report water level, signal strength, uptime and fault state."},{"title":"Decide","body":"The flood engine applies absolute thresholds, rate of rise, hysteresis, cooldown and multi-sensor confirmation."},{"title":"Act","body":"The controller raises or lowers the perimeter barrier with limit-switch feedback and a local fail-safe."},{"title":"Notify","body":"Critical events fan out to email, SMS, Web Push and the public status page. In-app alerts are always available."}]},{"id":"status-1","type":"status","title":"Current site state","source":"public-status"},{"id":"chart-1","type":"chart","title":"Water level, last 40 samples","source":"public-history","limit":40},{"id":"alert-1","type":"alert","title":"Safety boundary","tone":"warning","body":"This is an educational prototype. It is not a real flood defence, evacuation service or emergency warning system. Never rely on it for life-safety decisions."},{"id":"text-2","type":"text","title":"Who it is for","body":"Students and judges can watch the full loop end to end: device provisioning, telemetry ingest, policy evaluation, barrier commands, notification fan-out, audit trail and rollback. Every number in the dashboard comes from the database or from a labelled simulation."},{"id":"buttons-1","type":"buttons","items":[{"label":"Create an account","href":"/register"},{"label":"Devices and firmware","href":"/devices"},{"label":"Admin console","href":"/admin"}]}]',
 'Initial published landing page.', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
