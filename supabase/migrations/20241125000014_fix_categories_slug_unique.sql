-- Fix: Change global UNIQUE(slug) to per-user UNIQUE(slug, user_id)
-- The original UNIQUE(slug) was created before multi-user support

-- Drop the old global unique constraint
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_slug_key;

-- Drop old index if exists
DROP INDEX IF EXISTS idx_categories_slug;

-- Add composite unique constraint (slug unique per user)
ALTER TABLE categories ADD CONSTRAINT categories_slug_user_unique UNIQUE (slug, user_id);
