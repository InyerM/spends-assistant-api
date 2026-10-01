-- Keep the source sign while matching a bank debit to the ledger magnitude.
CREATE OR REPLACE FUNCTION public.decide_document_observation(
  p_observation_id UUID,
  p_action TEXT,
  p_transaction_id UUID,
  p_idempotency_key UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_observation RECORD;
  v_transaction RECORD;
  v_existing RECORD;
  v_date DATE;
  v_date_text TEXT;
  v_before JSONB;
  v_after JSONB;
  v_transaction_snapshot JSONB;
  v_decision_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_observation_id IS NULL OR p_idempotency_key IS NULL OR
    (p_action = 'accept' AND p_transaction_id IS NULL) OR
    (p_action = 'reject_observation' AND p_transaction_id IS NOT NULL) OR
    p_action IS NULL OR p_action NOT IN ('accept', 'reject_observation') THEN
    RAISE EXCEPTION 'Invalid review decision' USING ERRCODE = '22023';
  END IF;

  -- Locking the observation serializes retries and competing decisions.
  SELECT o.id, o.status, o.match_transaction_id, o.amount,
    o.occurred_at_text, o.description, d.status AS document_status
  INTO v_observation
  FROM public.document_observations o
  JOIN public.documents d ON d.id = o.document_id AND d.user_id = o.user_id
  WHERE o.id = p_observation_id AND o.user_id = v_user
  FOR UPDATE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observation not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, observation_id, action, transaction_id INTO v_existing
  FROM public.document_observation_decisions
  WHERE user_id = v_user AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.observation_id = p_observation_id AND v_existing.action = p_action
      AND v_existing.transaction_id IS NOT DISTINCT FROM p_transaction_id THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'Idempotency key reused for a different decision' USING ERRCODE = '23505';
  END IF;
  IF v_observation.status <> 'pending' OR v_observation.document_status <> 'extracted' THEN
    RAISE EXCEPTION 'Observation is not pending review' USING ERRCODE = '23514';
  END IF;

  v_before := jsonb_build_object('status', v_observation.status,
    'match_transaction_id', v_observation.match_transaction_id);
  IF p_action = 'accept' THEN
    SELECT id, user_id, amount, date, description, deleted_at, type
    INTO v_transaction FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND OR v_transaction.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_observation.amount IS NULL OR abs(v_observation.amount) <> v_transaction.amount THEN
      RAISE EXCEPTION 'Amounts do not match' USING ERRCODE = '23514';
    END IF;
    IF v_observation.amount < 0 AND v_transaction.type = 'income' THEN
      RAISE EXCEPTION 'Signed bank debit cannot match an income' USING ERRCODE = '23514';
    END IF;
    IF v_observation.occurred_at_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T)' THEN
      v_date_text := left(v_observation.occurred_at_text, 10);
      BEGIN
        v_date := to_date(v_date_text, 'YYYY-MM-DD');
        IF to_char(v_date, 'YYYY-MM-DD') <> v_date_text THEN v_date := NULL; END IF;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        v_date := NULL;
      END;
    END IF;
    IF v_date IS NOT NULL AND abs(v_transaction.date - v_date) > 3 THEN
      RAISE EXCEPTION 'Dates are more than three days apart' USING ERRCODE = '23514';
    END IF;
    v_transaction_snapshot := jsonb_build_object('id', v_transaction.id,
      'amount', v_transaction.amount, 'date', v_transaction.date,
      'description', v_transaction.description);
    UPDATE public.document_observations
    SET status = 'confirmed', match_transaction_id = p_transaction_id
    WHERE id = p_observation_id AND user_id = v_user;
    v_after := jsonb_build_object('status', 'confirmed', 'match_transaction_id', p_transaction_id);
  ELSE
    UPDATE public.document_observations SET status = 'rejected'
    WHERE id = p_observation_id AND user_id = v_user;
    v_after := jsonb_build_object('status', 'rejected', 'match_transaction_id', NULL);
  END IF;

  INSERT INTO public.document_observation_decisions (
    user_id, observation_id, transaction_id, action, idempotency_key,
    before_state, after_state, transaction_snapshot
  ) VALUES (
    v_user, p_observation_id, p_transaction_id, p_action, p_idempotency_key,
    v_before, v_after, v_transaction_snapshot
  ) RETURNING id INTO v_decision_id;
  RETURN v_decision_id;
END;
$$;
