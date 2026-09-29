-- Private document inbox. Extraction creates review drafts, never transactions.
CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  document_type TEXT CHECK (document_type IN ('receipt', 'bank_screenshot', 'sms_screenshot', 'statement', 'other')),
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'extracted', 'failed')),
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

-- A failed or abandoned extraction may be retried. The claim is a single row
-- update so simultaneous requests cannot both start the vision call.
CREATE FUNCTION public.claim_document_extraction(p_document_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.documents
  SET status = 'processing', error_code = NULL
  WHERE id = p_document_id AND user_id = auth.uid()
    AND (status IN ('uploaded', 'failed')
      OR (status = 'processing' AND updated_at < now() - INTERVAL '5 minutes'));
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;

-- Replacing drafts and advancing the document state must commit together.
-- The caller supplies only extracted fields; ownership and review state come
-- from the authenticated session and the database.
CREATE FUNCTION public.complete_document_extraction(
  p_document_id UUID,
  p_document_type TEXT,
  p_model TEXT,
  p_observations JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_observation JSONB;
  v_count INTEGER;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_document_type IS NULL OR p_document_type NOT IN
    ('receipt', 'bank_screenshot', 'sms_screenshot', 'statement', 'other')
    OR p_model IS NULL OR length(trim(p_model)) = 0
    OR jsonb_typeof(p_observations) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_observations) > 50 THEN
    RAISE EXCEPTION 'Invalid extraction result' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.documents
  WHERE id = p_document_id AND user_id = v_user AND status = 'processing'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document is not claimed by caller' USING ERRCODE = '23514';
  END IF;

  FOR v_observation IN SELECT value FROM jsonb_array_elements(p_observations) AS item(value)
  LOOP
    IF jsonb_typeof(v_observation) IS DISTINCT FROM 'object'
      OR v_observation->>'ordinal' IS NULL
      OR v_observation->>'description' IS NULL
      OR v_observation->>'source_excerpt' IS NULL
      OR v_observation->>'confidence' IS NULL THEN
      RAISE EXCEPTION 'Invalid observation' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  DELETE FROM public.document_observations WHERE document_id = p_document_id AND user_id = v_user;
  INSERT INTO public.document_observations (
    document_id, user_id, ordinal, amount, currency, occurred_at_text,
    description, counterparty, reference, source_excerpt, confidence
  )
  SELECT p_document_id, v_user, (value->>'ordinal')::INTEGER,
    (value->>'amount')::NUMERIC, value->>'currency', value->>'occurred_at_text',
    value->>'description', value->>'counterparty', value->>'reference',
    value->>'source_excerpt', (value->>'confidence')::NUMERIC
  FROM jsonb_array_elements(p_observations) AS item(value);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.documents
  SET status = 'extracted', document_type = p_document_type, model = p_model, error_code = NULL
  WHERE id = p_document_id AND user_id = v_user;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_document_extraction(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_document_extraction(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_document_extraction(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_extraction(UUID, TEXT, TEXT, JSONB) TO authenticated;

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
