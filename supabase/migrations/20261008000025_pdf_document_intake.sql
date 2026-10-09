-- PDF uploads stay private and use the same owner-scoped audited review flow.
ALTER TABLE public.documents DROP CONSTRAINT documents_mime_type_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_mime_type_check
  CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf'));
UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/png','image/jpeg','image/webp','application/pdf']
  WHERE id = 'documents';

-- Bounded multi-page extraction completes atomically; never silently truncate draft rows.
CREATE OR REPLACE FUNCTION public.complete_document_extraction_server(
  p_document_id UUID,
  p_owner_id UUID,
  p_claim_token UUID,
  p_document_type TEXT,
  p_model TEXT,
  p_observations JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_observation JSONB;
  v_count INTEGER;
BEGIN
  IF p_owner_id IS NULL OR p_claim_token IS NULL
    OR p_document_type IS NULL OR p_document_type NOT IN
      ('receipt', 'bank_screenshot', 'sms_screenshot', 'statement', 'other')
    OR p_model IS NULL OR length(trim(p_model)) = 0
    OR jsonb_typeof(p_observations) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_observations) > 500 THEN
    RAISE EXCEPTION 'Invalid extraction result' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.documents
  WHERE id = p_document_id AND user_id = p_owner_id AND status = 'processing'
    AND processing_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document is not claimed by owner' USING ERRCODE = '23514';
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

  DELETE FROM public.document_observations
  WHERE document_id = p_document_id AND user_id = p_owner_id;
  INSERT INTO public.document_observations (
    document_id, user_id, ordinal, amount, currency, occurred_at_text,
    description, counterparty, reference, source_excerpt, confidence
  )
  SELECT p_document_id, p_owner_id, (value->>'ordinal')::INTEGER,
    (value->>'amount')::NUMERIC, value->>'currency', value->>'occurred_at_text',
    value->>'description', value->>'counterparty', value->>'reference',
    value->>'source_excerpt', (value->>'confidence')::NUMERIC
  FROM jsonb_array_elements(p_observations) AS item(value);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.documents
  SET status = 'extracted', processing_token = NULL, document_type = p_document_type,
    model = p_model, error_code = NULL
  WHERE id = p_document_id AND user_id = p_owner_id AND status = 'processing'
    AND processing_token = p_claim_token;
  RETURN v_count;
END;
$$;

