-- Operations console sessions and backup bookkeeping.

CREATE TABLE IF NOT EXISTS ops_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  credential_id TEXT REFERENCES ops_credentials(id) ON DELETE SET NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_sessions_user ON ops_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'MANUAL',
  target TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS deployment_info (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT 'production',
  app_version TEXT NOT NULL DEFAULT '',
  git_commit TEXT NOT NULL DEFAULT '',
  deployed_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO deployment_info(id, tenant_id, environment, app_version, git_commit, deployed_at, note)
VALUES ('deploy-current', 'tenant-floodgrid', 'production', '1.0.0', 'unknown', '2026-01-01T00:00:00.000Z', 'Set APP_VERSION and GIT_COMMIT at deploy time for accurate rollback information.');
