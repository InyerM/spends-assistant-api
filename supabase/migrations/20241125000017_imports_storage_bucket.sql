-- ====================================
-- MIGRATION 17: IMPORTS STORAGE BUCKET & TABLE
-- ====================================

-- 1. Create storage bucket for import files
INSERT INTO storage.buckets (id, name, public)
VALUES ('imports', 'imports', false)
ON CONFLICT (id) DO NOTHING;

-- 2. RLS policies for imports bucket
-- Users can upload to their own folder
CREATE POLICY "users_upload_imports"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'imports'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can read their own files
CREATE POLICY "users_read_own_imports"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'imports'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Users can delete their own files
CREATE POLICY "users_delete_own_imports"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'imports'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Service role has full access
CREATE POLICY "service_role_imports_bucket"
ON storage.objects FOR ALL TO service_role
USING (bucket_id = 'imports')
WITH CHECK (bucket_id = 'imports');

-- 3. Extend imports table with new columns
-- Note: user_id, idx_imports_user_id, and "users_own_imports" policy
-- already exist from migration 008 (multi-user support)
ALTER TABLE imports ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS row_count INTEGER;
ALTER TABLE imports ADD COLUMN IF NOT EXISTS imported_count INTEGER;

-- Update status constraint to include our values
ALTER TABLE imports DROP CONSTRAINT IF EXISTS imports_status_check;
ALTER TABLE imports ADD CONSTRAINT imports_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'in_progress'));

-- Index for created_at lookups
CREATE INDEX IF NOT EXISTS idx_imports_created ON imports (created_at DESC);
