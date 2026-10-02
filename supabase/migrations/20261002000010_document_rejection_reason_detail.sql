ALTER TABLE public.document_observation_rejection_reasons
  ADD COLUMN reason_detail text
  CHECK (reason_detail IS NULL OR (
    reason = 'other' AND length(btrim(reason_detail)) BETWEEN 1 AND 500
  ));

CREATE FUNCTION public.decide_document_observation_with_reason(
  p_observation_id uuid, p_action text, p_transaction_id uuid,
  p_idempotency_key uuid, p_reason text, p_reason_detail text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_decision_id uuid;
  v_existing_reason text;
  v_existing_detail text;
  v_detail text := NULLIF(btrim(p_reason_detail), '');
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_action <> 'reject_observation' OR p_reason IS NULL OR p_reason NOT IN (
    'already_recorded', 'duplicate_capture', 'not_a_transaction',
    'unreadable', 'wrong_account', 'other'
  ) THEN
    RAISE EXCEPTION 'Invalid rejection reason' USING ERRCODE = '22023';
  END IF;
  IF (p_reason = 'other' AND (v_detail IS NULL OR length(v_detail) > 500))
    OR (p_reason <> 'other' AND p_reason_detail IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid rejection reason detail' USING ERRCODE = '22023';
  END IF;

  v_decision_id := public.decide_document_observation(
    p_observation_id, p_action, p_transaction_id, p_idempotency_key
  );
  INSERT INTO public.document_observation_rejection_reasons(
    decision_id, user_id, reason, reason_detail
  ) VALUES (v_decision_id, v_user, p_reason, v_detail)
  ON CONFLICT (decision_id) DO NOTHING;

  SELECT reason, reason_detail INTO v_existing_reason, v_existing_detail
  FROM public.document_observation_rejection_reasons
  WHERE decision_id = v_decision_id AND user_id = v_user;
  IF v_existing_reason IS DISTINCT FROM p_reason
    OR v_existing_detail IS DISTINCT FROM v_detail THEN
    RAISE EXCEPTION 'Idempotency key reused for a different reason detail'
      USING ERRCODE = '23505';
  END IF;
  RETURN v_decision_id;
END;
$$;
REVOKE ALL ON FUNCTION public.decide_document_observation_with_reason(uuid,text,uuid,uuid,text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.decide_document_observation_with_reason(uuid,text,uuid,uuid,text,text)
  TO authenticated;
