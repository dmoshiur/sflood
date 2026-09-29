-- Prevent stale installations from exposing an enabled simulation feature flag.
UPDATE site_settings
SET value_json=replace(value_json,'"simulationMode":true','"simulationMode":false'), updated_at=datetime('now')
WHERE key='feature_flags' AND instr(value_json,'"simulationMode":true') > 0;
