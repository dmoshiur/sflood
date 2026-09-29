-- The flood engine uses NORMAL/WATCH/WARNING/CRITICAL/RECOVERY. The original
-- telemetry table only allowed the v1 demo bands (SAFE/WATCH/WARNING/CRITICAL/
-- UNKNOWN/FAULT), so the table is rebuilt with the engine states and the legacy
-- values are mapped across.

CREATE TABLE IF NOT EXISTS telemetry_migrated (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  level_cm REAL NOT NULL,
  rainfall_mm REAL,
  rate_cm_per_min REAL,
  state TEXT NOT NULL CHECK(state IN ('NORMAL','WATCH','WARNING','CRITICAL','RECOVERY')),
  barrier_state TEXT NOT NULL DEFAULT 'DOWN',
  sensor_healthy INTEGER NOT NULL DEFAULT 1,
  battery_mv INTEGER,
  rssi INTEGER,
  simulated INTEGER NOT NULL DEFAULT 0,
  uptime_seconds INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(device_id, seq)
);

INSERT INTO telemetry_migrated(id,device_id,seq,level_cm,rainfall_mm,rate_cm_per_min,state,barrier_state,sensor_healthy,battery_mv,rssi,simulated,uptime_seconds,created_at)
SELECT id,device_id,seq,level_cm,rainfall_mm,rate_cm_per_min,
  CASE UPPER(COALESCE(state,'UNKNOWN'))
    WHEN 'SAFE' THEN 'NORMAL'
    WHEN 'UNKNOWN' THEN 'NORMAL'
    WHEN 'FAULT' THEN 'NORMAL'
    WHEN 'WATCH' THEN 'WATCH'
    WHEN 'WARNING' THEN 'WARNING'
    WHEN 'CRITICAL' THEN 'CRITICAL'
    WHEN 'RECOVERY' THEN 'RECOVERY'
    ELSE 'NORMAL'
  END,
  COALESCE(barrier_state,'DOWN'),COALESCE(sensor_healthy,1),battery_mv,rssi,COALESCE(simulated,0),uptime_seconds,created_at
FROM telemetry;

DROP TABLE telemetry;
ALTER TABLE telemetry_migrated RENAME TO telemetry;

CREATE INDEX IF NOT EXISTS idx_telemetry_device_created ON telemetry(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_rate ON telemetry(device_id, created_at, rate_cm_per_min);
