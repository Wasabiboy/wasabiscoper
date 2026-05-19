CREATE TABLE IF NOT EXISTS session_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  version INT DEFAULT 1,
  content_md TEXT NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);
