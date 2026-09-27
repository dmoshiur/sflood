ALTER TABLE subscriptions ADD COLUMN verification_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_subscriptions_email_verification ON subscriptions(verification_token_hash, verification_expires_at);
