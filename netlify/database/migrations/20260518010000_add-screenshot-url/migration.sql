-- Add screenshot reference to page_contexts
ALTER TABLE page_contexts ADD COLUMN IF NOT EXISTS screenshot_url TEXT;
ALTER TABLE page_contexts ADD COLUMN IF NOT EXISTS screenshot_blob_key TEXT;
