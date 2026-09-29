-- A review decision links an extracted observation to an existing transaction.
-- Neither this migration nor its RPC changes transaction rows or balances.
ALTER TABLE public.transactions ADD CONSTRAINT transactions_id_user_unique UNIQUE (id, user_id);
ALTER TABLE public.document_observations ADD CONSTRAINT document_observations_id_user_unique UNIQUE (id, user_id);
ALTER TABLE public.document_observations ADD COLUMN match_transaction_id UUID;
ALTER TABLE public.document_observations
  ADD CONSTRAINT document_observations_match_owner_fk
  FOREIGN KEY (match_transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE;
ALTER TABLE public.document_observations
  ADD CONSTRAINT document_observations_confirmed_link_check
  CHECK ((status = 'confirmed') = (match_transaction_id IS NOT NULL)) NOT VALID;
CREATE UNIQUE INDEX document_observations_one_match_per_transaction
  ON public.document_observations (user_id, match_transaction_id)
  WHERE match_transaction_id IS NOT NULL;

CREATE TABLE public.document_observation_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  transaction_id UUID,
  action TEXT NOT NULL CHECK (action IN ('accept', 'reject_observation')),
  idempotency_key UUID NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  transaction_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_observation_decisions_owner_fk
    FOREIGN KEY (observation_id, user_id)
    REFERENCES public.document_observations (id, user_id) ON DELETE CASCADE,
  CONSTRAINT document_observation_decisions_transaction_owner_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT document_observation_decisions_action_transaction_check
    CHECK ((action = 'accept') = (transaction_id IS NOT NULL)),
  CONSTRAINT document_observation_decisions_idempotency_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX document_observation_decisions_observation_idx
  ON public.document_observation_decisions (user_id, observation_id, created_at);

CREATE FUNCTION public.reject_document_decision_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- A source document or transaction being erased must erase its private audit
  -- record too. Direct edits remain forbidden while both parents exist.
  IF TG_OP = 'UPDATE' OR
    (EXISTS (SELECT 1 FROM public.document_observations WHERE id = OLD.observation_id)
      AND (OLD.transaction_id IS NULL OR
        EXISTS (SELECT 1 FROM public.transactions WHERE id = OLD.transaction_id))) THEN
    RAISE EXCEPTION 'Document review decisions are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER document_observation_decisions_immutable
  BEFORE UPDATE OR DELETE ON public.document_observation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_document_decision_mutation();

CREATE FUNCTION public.guard_reviewed_observation_link()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('confirmed', 'rejected') AND
    (NEW.status, NEW.match_transaction_id) IS DISTINCT FROM
    (OLD.status, OLD.match_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed observation links are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_observations_reviewed_link_guard
  BEFORE UPDATE ON public.document_observations
  FOR EACH ROW EXECUTE FUNCTION public.guard_reviewed_observation_link();

ALTER TABLE public.document_observation_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_observation_decisions_owner ON public.document_observation_decisions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
GRANT SELECT ON public.document_observation_decisions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.document_observation_decisions FROM authenticated;

-- Only the definer RPC may change review state or links. Extraction uses its
-- own definer RPC and does not need client-side observation writes.
REVOKE INSERT, UPDATE, DELETE ON public.document_observations FROM authenticated;

-- Browser inserts are upload drafts only. Extraction state is owned by the
-- claim/completion/failure RPCs, all of which check the caller and token.
CREATE FUNCTION public.guard_document_insert_state()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'uploaded' OR NEW.processing_token IS NOT NULL
    OR NEW.document_type IS NOT NULL OR NEW.model IS NOT NULL
    OR NEW.error_code IS NOT NULL THEN
    RAISE EXCEPTION 'New documents must be uploaded drafts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_insert_state_guard
  BEFORE INSERT ON public.documents FOR EACH ROW
  EXECUTE FUNCTION public.guard_document_insert_state();
REVOKE UPDATE ON public.documents FROM authenticated;

CREATE FUNCTION public.fail_document_extraction(
  p_document_id UUID, p_claim_token UUID, p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_claim_token IS NULL OR p_error_code IS NULL OR
    p_error_code !~ '^[A-Z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'Invalid extraction failure' USING ERRCODE = '22023';
  END IF;
  UPDATE public.documents
  SET status = 'failed', processing_token = NULL, error_code = p_error_code
  WHERE id = p_document_id AND user_id = auth.uid()
    AND status = 'processing' AND processing_token = p_claim_token;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_document_extraction(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_document_extraction(UUID, UUID, TEXT) TO authenticated;

CREATE FUNCTION public.decide_document_observation(
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
    SELECT id, user_id, amount, date, description, deleted_at
    INTO v_transaction FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND OR v_transaction.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_observation.amount IS NULL OR v_observation.amount <> v_transaction.amount THEN
      RAISE EXCEPTION 'Amounts do not match' USING ERRCODE = '23514';
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

REVOKE ALL ON FUNCTION public.decide_document_observation(UUID, TEXT, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.decide_document_observation(UUID, TEXT, UUID, UUID) TO authenticated;
