-- Wasabi Scope schema
-- Run via: node scripts/migrate.js
-- Or paste into Neon SQL editor

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users (beta: simple token-based, no full auth UI yet)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  display_name TEXT,
  api_token TEXT UNIQUE NOT NULL, -- the token the extension sends in x-wasabi-token
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scoping sessions (one per client engagement)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT,
  project_type TEXT, -- 'knack-rebuild' | 'zoho-rebuild' | 'erp-integration' | 'custom-saas' | 'general'
  status TEXT DEFAULT 'active', -- 'active' | 'completed' | 'archived'
  coverage JSONB DEFAULT '{}'::jsonb, -- {data-model: 'done', workflows: 'partial', ...}
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);

-- Chat messages between user and AI agent
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb, -- token counts, model, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- Captured page context snapshots (DOM extracts from content script)
CREATE TABLE IF NOT EXISTS page_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  url TEXT,
  title TEXT,
  context JSONB NOT NULL, -- full extracted forms/tables/nav structure
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_contexts_session ON page_contexts(session_id, captured_at);

-- Uploaded reference files (PDFs, screenshots, schemas)
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  text_content TEXT, -- extracted text for files we could parse
  binary_url TEXT, -- if we store binaries elsewhere (S3, Netlify Blobs)
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recording transcripts
CREATE TABLE IF NOT EXISTS transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT, -- 'whisper' | 'web-speech' | 'manual'
  text TEXT NOT NULL,
  duration_seconds INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Generated scoping documents
CREATE TABLE IF NOT EXISTS scope_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  version INT DEFAULT 1,
  content_md TEXT NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update sessions.updated_at on any related write
CREATE OR REPLACE FUNCTION touch_session() RETURNS TRIGGER AS $$
BEGIN
  UPDATE sessions SET updated_at = NOW() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_touch ON messages;
CREATE TRIGGER messages_touch AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_session();
