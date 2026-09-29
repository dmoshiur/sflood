-- Make settings and flag authorship survive account deletion: ON DELETE SET NULL
-- instead of blocking the delete. Small tables, so they are rebuilt in place.

CREATE TABLE IF NOT EXISTS site_settings_migrated (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO site_settings_migrated(key,value_json,updated_by,updated_at)
SELECT key,value_json,NULL,updated_at FROM site_settings;

DROP TABLE site_settings;
ALTER TABLE site_settings_migrated RENAME TO site_settings;

CREATE TABLE IF NOT EXISTS feature_flags_migrated (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO feature_flags_migrated(key,value_json,description,updated_by,updated_at)
SELECT key,value_json,description,NULL,updated_at FROM feature_flags;

DROP TABLE feature_flags;
ALTER TABLE feature_flags_migrated RENAME TO feature_flags;
