-- Private document inbox. Extraction creates review drafts, never transactions.
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  document_type TEXT CHECK (document_type IN ('receipt', 'bank_screenshot', 'sms_screenshot', 'statement', 'other')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'extracted', 'failed')),
  model TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_file_path_owner CHECK (split_part(file_path, '/', 1) = user_id::text),
  CONSTRAINT documents_user_file_path_unique UNIQUE (user_id, file_path),
  CONSTRAINT documents_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX documents_user_created_idx ON public.documents (user_id, created_at DESC);
CREATE INDEX documents_user_sha256_idx ON public.documents (user_id, sha256);
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.document_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  amount NUMERIC(18, 2) CHECK (amount > 0),
  currency TEXT,
  occurred_at_text TEXT,
  description TEXT NOT NULL,
  counterparty TEXT,
  reference TEXT,
  source_excerpt TEXT NOT NULL,
  confidence NUMERIC(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_observations_document_owner_fk
    FOREIGN KEY (document_id, user_id) REFERENCES public.documents(id, user_id) ON DELETE CASCADE,
  CONSTRAINT document_observations_document_ordinal_unique UNIQUE (document_id, ordinal)
);

CREATE INDEX document_observations_user_document_idx
  ON public.document_observations (user_id, document_id);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_owner ON public.documents
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY document_observations_owner ON public.document_observations
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY documents_service_role ON public.documents
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY document_observations_service_role ON public.document_observations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_observations TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 5242880, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY documents_storage_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
CREATE POLICY documents_storage_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
CREATE POLICY documents_storage_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
