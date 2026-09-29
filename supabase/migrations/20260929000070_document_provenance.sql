-- The browser may claim its own upload, but only the trusted server may write
-- Worker extraction results. These functions never infer ownership from a
-- service-role session: every write requires the explicit owner and claim token.
REVOKE ALL ON FUNCTION public.complete_document_extraction(UUID, UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fail_document_extraction(UUID, UUID, TEXT)
  FROM PUBLIC, authenticated, service_role;

CREATE FUNCTION public.complete_document_extraction_server(
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
    OR jsonb_array_length(p_observations) > 50 THEN
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

CREATE FUNCTION public.fail_document_extraction_server(
  p_document_id UUID,
  p_owner_id UUID,
  p_claim_token UUID,
  p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_owner_id IS NULL OR p_claim_token IS NULL OR p_error_code IS NULL
    OR p_error_code !~ '^[A-Z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'Invalid extraction failure' USING ERRCODE = '22023';
  END IF;
  UPDATE public.documents
  SET status = 'failed', processing_token = NULL, error_code = p_error_code
  WHERE id = p_document_id AND user_id = p_owner_id
    AND status = 'processing' AND processing_token = p_claim_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_document_extraction_server(UUID, UUID, UUID, TEXT, TEXT, JSONB)
  FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.fail_document_extraction_server(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_extraction_server(UUID, UUID, UUID, TEXT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_document_extraction_server(UUID, UUID, UUID, TEXT)
  TO service_role;
