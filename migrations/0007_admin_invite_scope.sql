-- Local-admin invitations need an explicit site scope so that the invited
-- account is born already scoped to a city/site.

ALTER TABLE admin_invites ADD COLUMN city_id TEXT REFERENCES cities(id) ON DELETE SET NULL;
ALTER TABLE admin_invites ADD COLUMN zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL;
ALTER TABLE admin_invites ADD COLUMN role TEXT;
CREATE INDEX IF NOT EXISTS idx_admin_invites_scope ON admin_invites(tenant_id, city_id, zone_id);
