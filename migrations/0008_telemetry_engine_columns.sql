-- Telemetry columns used by the flood engine and the simulation label.

ALTER TABLE telemetry ADD COLUMN rate_cm_per_min REAL;
ALTER TABLE telemetry ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry ADD COLUMN uptime_seconds INTEGER;
CREATE INDEX IF NOT EXISTS idx_telemetry_rate ON telemetry(device_id, created_at, rate_cm_per_min);
