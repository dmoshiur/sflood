ALTER TABLE subscriptions ADD COLUMN phone_verified_at TEXT;
ALTER TABLE subscriptions ADD COLUMN phone_verification_token_hash TEXT;
ALTER TABLE subscriptions ADD COLUMN phone_verification_expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_subscriptions_phone_verification ON subscriptions(phone, phone_verified_at, phone_verification_expires_at);
