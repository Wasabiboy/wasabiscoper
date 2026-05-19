-- Link sessions to the URL of the client's app being demoed
-- Enables auto-resume when the sidepanel opens on the same site
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS target_url TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_target_url ON sessions(user_id, target_url, updated_at DESC);
