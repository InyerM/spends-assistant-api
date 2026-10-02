-- Keep the original OCR fields while allowing the owner to review a pending observation.
ALTER TABLE public.document_observations
  ADD COLUMN extracted_snapshot jsonb,
  ADD COLUMN reviewed_at timestamptz;

CREATE TABLE public.document_observation_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_observation_edits_owner_fk
    FOREIGN KEY (observation_id, user_id)
    REFERENCES public.document_observations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX document_observation_edits_owner_observation_idx
  ON public.document_observation_edits(user_id, observation_id, created_at DESC);

ALTER TABLE public.document_observation_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_observation_edits_owner ON public.document_observation_edits
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.document_observation_edits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.document_observation_edits TO authenticated;
GRANT ALL ON public.document_observation_edits TO service_role;

CREATE FUNCTION public.reject_document_observation_edit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (
    SELECT 1 FROM public.document_observations WHERE id = OLD.observation_id
  ) THEN
    RAISE EXCEPTION 'Document observation edits are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER document_observation_edits_immutable
  BEFORE UPDATE OR DELETE ON public.document_observation_edits
  FOR EACH ROW EXECUTE FUNCTION public.reject_document_observation_edit_mutation();

CREATE FUNCTION public.revise_document_observation(
  p_observation_id uuid,
  p_amount numeric,
  p_currency text,
  p_occurred_at_text text,
  p_description text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_observation record;
  v_before jsonb;
  v_after jsonb;
  v_date text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_amount IS NULL OR p_amount = 0 OR p_amount <> round(p_amount, 2)
    OR abs(p_amount) > 9999999999999.99 THEN
    RAISE EXCEPTION 'Invalid reviewed amount' USING ERRCODE = '22023';
  END IF;
  IF p_currency IS NOT NULL AND p_currency !~ '^[A-Z]{3,5}$' THEN
    RAISE EXCEPTION 'Invalid reviewed currency' USING ERRCODE = '22023';
  END IF;
  IF p_occurred_at_text IS NOT NULL THEN
    IF p_occurred_at_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T([01][0-9]|2[0-3]):[0-5][0-9])?$' THEN
      RAISE EXCEPTION 'Invalid reviewed date or time' USING ERRCODE = '22023';
    END IF;
    v_date := left(p_occurred_at_text, 10);
    IF to_char(to_date(v_date, 'YYYY-MM-DD'), 'YYYY-MM-DD') <> v_date THEN
      RAISE EXCEPTION 'Invalid reviewed date or time' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'Invalid reviewed description' USING ERRCODE = '22023';
  END IF;

  SELECT o.*, d.status AS document_status INTO v_observation
  FROM public.document_observations o
  JOIN public.documents d ON d.id = o.document_id AND d.user_id = o.user_id
  WHERE o.id = p_observation_id AND o.user_id = v_user
  FOR UPDATE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_observation.status <> 'pending' OR v_observation.document_status <> 'extracted' THEN
    RAISE EXCEPTION 'Observation is not pending review' USING ERRCODE = '23514';
  END IF;

  v_before := jsonb_build_object(
    'amount', v_observation.amount, 'currency', v_observation.currency,
    'occurred_at_text', v_observation.occurred_at_text,
    'description', v_observation.description
  );
  v_after := jsonb_build_object(
    'amount', p_amount, 'currency', p_currency,
    'occurred_at_text', p_occurred_at_text,
    'description', btrim(p_description)
  );
  UPDATE public.document_observations SET
    amount = p_amount,
    currency = p_currency,
    occurred_at_text = p_occurred_at_text,
    description = btrim(p_description),
    extracted_snapshot = coalesce(extracted_snapshot, v_before),
    reviewed_at = now()
  WHERE id = p_observation_id AND user_id = v_user;
  INSERT INTO public.document_observation_edits(
    user_id, observation_id, before_state, after_state
  ) VALUES (v_user, p_observation_id, v_before, v_after);
  RETURN v_after;
END;
$$;
REVOKE ALL ON FUNCTION public.revise_document_observation(uuid,numeric,text,text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.revise_document_observation(uuid,numeric,text,text,text)
  TO authenticated;

-- A failed link must remain recoverable; rejecting the observation would orphan
-- the already posted balance change.
CREATE FUNCTION public.guard_created_document_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'rejected' AND EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.user_id = NEW.user_id AND t.source = 'web-document'
      AND t.deleted_at IS NULL
      AND t.parsed_data->>'document_id' = NEW.document_id::text
      AND t.parsed_data->>'observation_id' = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'Observation has a created transaction requiring link review'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_observations_created_transaction_guard
  BEFORE UPDATE OF status ON public.document_observations
  FOR EACH ROW EXECUTE FUNCTION public.guard_created_document_transaction();

CREATE INDEX transactions_document_observation_recovery_idx
  ON public.transactions (user_id, (parsed_data->>'observation_id'))
  WHERE source = 'web-document' AND deleted_at IS NULL;
