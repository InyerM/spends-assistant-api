-- Correct a statement-verified expense without rewriting its Shortcut match decision.
-- The request ID makes retries safe; the expected account and amount reject stale reviews.
ALTER TABLE public.shortcut_inbox_match_decisions
  ADD CONSTRAINT shortcut_match_decision_owner_transaction_unique
  UNIQUE (id, user_id, transaction_id);

CREATE TABLE public.shortcut_transaction_financial_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL,
  match_decision_id uuid NOT NULL,
  old_account_id uuid NOT NULL,
  new_account_id uuid NOT NULL,
  old_amount numeric(15,2) NOT NULL,
  new_amount numeric(15,2) NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_financial_correction_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT shortcut_financial_correction_transaction_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_financial_correction_decision_fk
    FOREIGN KEY (match_decision_id, user_id, transaction_id)
    REFERENCES public.shortcut_inbox_match_decisions (id, user_id, transaction_id)
    ON DELETE CASCADE,
  CONSTRAINT shortcut_financial_correction_changed_account
    CHECK (old_account_id <> new_account_id),
  CONSTRAINT shortcut_financial_correction_positive_amounts
    CHECK (old_amount > 0 AND new_amount > 0)
);
CREATE INDEX shortcut_financial_correction_transaction_idx
  ON public.shortcut_transaction_financial_corrections (user_id, transaction_id, created_at DESC);

CREATE FUNCTION public.reject_shortcut_financial_correction_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut financial corrections are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_financial_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_transaction_financial_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_financial_correction_mutation();

ALTER TABLE public.shortcut_transaction_financial_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_financial_correction_select_owner
  ON public.shortcut_transaction_financial_corrections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_transaction_financial_corrections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_transaction_financial_corrections TO authenticated, service_role;

CREATE FUNCTION public.correct_shortcut_matched_expense(
  p_request_id uuid,
  p_transaction_id uuid,
  p_match_decision_id uuid,
  p_expected_account_id uuid,
  p_expected_amount numeric,
  p_new_account_id uuid,
  p_new_amount numeric,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.shortcut_transaction_financial_corrections%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_inbox_id uuid;
  v_inbox_status text;
  v_account uuid;
  v_amount numeric(15,2);
  v_correction public.shortcut_transaction_financial_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transaction_id IS NULL OR p_match_decision_id IS NULL
    OR p_expected_account_id IS NULL OR p_expected_amount IS NULL
    OR p_new_account_id IS NULL OR p_expected_account_id = p_new_account_id THEN
    RAISE EXCEPTION 'A distinct account and complete correction request are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_amount <= 0 OR p_expected_amount <> p_expected_amount::numeric(15,2)
    OR (p_new_amount IS NOT NULL AND
      (p_new_amount <= 0 OR p_new_amount <> p_new_amount::numeric(15,2))) THEN
    RAISE EXCEPTION 'Correction amounts must be positive with at most two decimals'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR p_evidence->>'source' IS DISTINCT FROM 'bank_statement'
    OR jsonb_typeof(p_evidence->'document') IS DISTINCT FROM 'string'
    OR length(btrim(p_evidence->>'document')) = 0
    OR jsonb_typeof(p_evidence->'line') IS DISTINCT FROM 'string'
    OR length(btrim(p_evidence->>'line')) = 0
    OR jsonb_typeof(p_evidence->'page') IS DISTINCT FROM 'number'
    OR (p_evidence->>'page') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Bank statement evidence requires document, page, and line'
      USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'transaction_id', p_transaction_id, 'match_decision_id', p_match_decision_id,
    'expected_account_id', p_expected_account_id, 'expected_amount', p_expected_amount,
    'new_account_id', p_new_account_id, 'new_amount', p_new_amount,
    'evidence', p_evidence)::text);

  -- Match manual creates and edits. The inbox lock also serializes a match reversal.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.shortcut_transaction_financial_corrections
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different correction'
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('correction', to_jsonb(v_existing), 'replayed', true);
  END IF;

  SELECT * INTO v_old FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT inbox_item_id INTO v_inbox_id FROM public.shortcut_inbox_match_decisions
    WHERE id = p_match_decision_id AND user_id = v_user
      AND transaction_id = p_transaction_id AND decision_type = 'matched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Shortcut match not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT status INTO v_inbox_status FROM public.shortcut_inbox_items
    WHERE id = v_inbox_id AND user_id = v_user FOR UPDATE;
  IF v_inbox_status IS DISTINCT FROM 'matched' OR EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_reversals
      WHERE decision_id = p_match_decision_id) THEN
    RAISE EXCEPTION 'Active Shortcut match required' USING ERRCODE = '23514';
  END IF;

  -- Other financial RPCs lock accounts by UUID before the transaction row.
  FOR v_account IN
    SELECT DISTINCT id FROM unnest(ARRAY[v_old.account_id,p_new_account_id]) AS id ORDER BY id
  LOOP
    PERFORM 1 FROM public.accounts WHERE id = v_account AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT * INTO v_locked FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;
  IF (v_locked.account_id,v_locked.amount,v_locked.type)
      IS DISTINCT FROM (v_old.account_id,v_old.amount,v_old.type)
    OR v_locked.account_id IS DISTINCT FROM p_expected_account_id
    OR v_locked.amount IS DISTINCT FROM p_expected_amount THEN
    RAISE EXCEPTION 'Transaction changed during review; refresh the statement match'
      USING ERRCODE = '40001';
  END IF;
  IF v_locked.type <> 'expense' OR v_locked.transfer_to_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only single-account expenses can use this correction'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts
    WHERE id = p_new_account_id AND user_id = v_user AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'New account is inactive or deleted' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_observation_decisions
    WHERE user_id = v_user AND transaction_id = p_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed document decision requires a separate correction'
      USING ERRCODE = '23514';
  END IF;
  v_amount := coalesce(p_new_amount, v_locked.amount)::numeric(15,2);

  UPDATE public.transactions SET account_id = p_new_account_id,
    amount = v_amount, updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) + v_locked.amount
    WHERE id = v_locked.account_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) - v_amount
    WHERE id = p_new_account_id AND user_id = v_user;
  INSERT INTO public.shortcut_transaction_financial_corrections (
    user_id, request_id, request_hash, transaction_id, match_decision_id,
    old_account_id, new_account_id, old_amount, new_amount, evidence
  ) VALUES (
    v_user, p_request_id, v_hash, p_transaction_id, p_match_decision_id,
    v_locked.account_id, p_new_account_id, v_locked.amount, v_amount, p_evidence
  ) RETURNING * INTO v_correction;
  RETURN jsonb_build_object('correction', to_jsonb(v_correction), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_shortcut_matched_expense(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.correct_shortcut_matched_expense(
  uuid, uuid, uuid, uuid, numeric, uuid, numeric, jsonb)
  TO authenticated;
