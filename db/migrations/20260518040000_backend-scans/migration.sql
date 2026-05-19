CREATE TABLE IF NOT EXISTS backend_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'knack',
  app_id TEXT,
  raw_schema JSONB NOT NULL DEFAULT '{}',
  summary JSONB NOT NULL DEFAULT '{}',
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);
