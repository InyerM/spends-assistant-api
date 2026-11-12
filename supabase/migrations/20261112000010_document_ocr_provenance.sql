ALTER TABLE public.document_observations ADD COLUMN source_page integer CHECK(source_page BETWEEN 1 AND 5);
ALTER TABLE public.documents ADD COLUMN extraction_page_count integer CHECK(extraction_page_count BETWEEN 1 AND 5), ADD COLUMN extraction_source_sha256 text, ADD COLUMN extraction_pathway text;
DROP FUNCTION public.complete_document_extraction_server(uuid,uuid,uuid,text,text,jsonb);
CREATE FUNCTION public.complete_document_extraction_server(
  p_document_id UUID,
  p_owner_id UUID,
  p_claim_token UUID,
  p_document_type TEXT,
  p_model TEXT,
  p_observations JSONB,
  p_page_count INTEGER DEFAULT NULL,
  p_source_sha256 TEXT DEFAULT NULL,
  p_pathway TEXT DEFAULT NULL
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

  IF p_pathway IS NULL AND (p_page_count IS NOT NULL OR p_source_sha256 IS NOT NULL) THEN RAISE EXCEPTION 'Invalid OCR provenance'; END IF;
  IF p_pathway IS NOT NULL AND (p_pathway <> 'cloud-pdf-mistral-ocr'
    OR p_page_count IS NULL OR p_page_count NOT BETWEEN 1 AND 5
    OR p_source_sha256 IS NULL OR p_source_sha256 !~ '^[a-f0-9]{64}$'
    OR jsonb_array_length(p_observations)>p_page_count*50
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_observations) r WHERE r->>'source_page' IS NULL OR (r->>'source_page')::integer NOT BETWEEN 1 AND p_page_count)) THEN
    RAISE EXCEPTION 'Invalid OCR provenance';
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

  IF EXISTS(SELECT 1 FROM public.document_observations WHERE document_id=p_document_id AND user_id=p_owner_id AND status<>'pending') THEN RAISE EXCEPTION 'Audited observations cannot be overwritten'; END IF;
  DELETE FROM public.document_observations
  WHERE document_id = p_document_id AND user_id = p_owner_id;
  INSERT INTO public.document_observations (
    document_id, user_id, ordinal, amount, currency, occurred_at_text,
    description, counterparty, reference, source_excerpt, confidence, source_page
  )
  SELECT p_document_id, p_owner_id, (value->>'ordinal')::INTEGER,
    (value->>'amount')::NUMERIC, value->>'currency', value->>'occurred_at_text',
    value->>'description', value->>'counterparty', value->>'reference',
    value->>'source_excerpt', (value->>'confidence')::NUMERIC, (value->>'source_page')::INTEGER
  FROM jsonb_array_elements(p_observations) AS item(value);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.documents
  SET status = 'extracted', processing_token = NULL, document_type = p_document_type,
    model = p_model, error_code = NULL, extraction_page_count=p_page_count, extraction_source_sha256=p_source_sha256, extraction_pathway=p_pathway
  WHERE id = p_document_id AND user_id = p_owner_id AND status = 'processing'
    AND processing_token = p_claim_token;
  RETURN v_count;
END;
$$;


REVOKE ALL ON FUNCTION public.complete_document_extraction_server(uuid,uuid,uuid,text,text,jsonb,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_extraction_server(uuid,uuid,uuid,text,text,jsonb,integer,text,text) TO service_role;
