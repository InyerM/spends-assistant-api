-- Append-only correction of an existing-transaction acknowledgement.
-- The original decision remains available for audit; no financial row changes.
ALTER TABLE public.shortcut_inbox_match_decisions
  DROP CONSTRAINT shortcut_match_one_per_inbox;
ALTER TABLE public.shortcut_inbox_match_decisions
  ADD CONSTRAINT shortcut_match_decision_owner_item_unique UNIQUE(id,user_id,inbox_item_id);

CREATE TABLE public.shortcut_inbox_match_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  inbox_item_id UUID NOT NULL,
  decision_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_reversal_decision_fk
    FOREIGN KEY (decision_id,user_id,inbox_item_id)
    REFERENCES public.shortcut_inbox_match_decisions(id,user_id,inbox_item_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_reversal_inbox_fk
    FOREIGN KEY (inbox_item_id,user_id)
    REFERENCES public.shortcut_inbox_items(id,user_id) ON DELETE CASCADE
);
CREATE INDEX shortcut_reversal_owner_item_idx
  ON public.shortcut_inbox_match_reversals(user_id,inbox_item_id,created_at DESC);

CREATE FUNCTION public.reject_shortcut_reversal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut match reversals are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_match_reversals_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_inbox_match_reversals
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_reversal_mutation();

ALTER TABLE public.shortcut_inbox_match_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_reversal_select_owner ON public.shortcut_inbox_match_reversals
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_inbox_match_reversals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_inbox_match_reversals TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_shortcut_match_status()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'matched' AND NEW.status = 'pending'
    AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_reversal', true) = 'on'
    AND EXISTS (
      SELECT 1 FROM public.shortcut_inbox_match_decisions d
      JOIN public.shortcut_inbox_match_reversals r ON r.decision_id = d.id
      WHERE d.inbox_item_id = NEW.id AND d.user_id = NEW.user_id
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('matched', 'created') AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (current_user = 'postgres'
      AND current_setting('app.shortcut_match_erasure', true) = 'on'
      AND pg_trigger_depth() > 1) THEN
    RAISE EXCEPTION 'Reviewed inbox status is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('matched', 'created') AND OLD.status IS DISTINCT FROM NEW.status
    AND NOT EXISTS (
      SELECT 1 FROM public.shortcut_inbox_match_decisions d
      WHERE d.inbox_item_id = NEW.id AND d.user_id = NEW.user_id
        AND d.decision_type = NEW.status
        AND NOT EXISTS (SELECT 1 FROM public.shortcut_inbox_match_reversals r
          WHERE r.decision_id = d.id)
    ) THEN
    RAISE EXCEPTION 'Reviewed status requires a current decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.reverse_shortcut_match(p_inbox_item_id UUID,p_decision_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user UUID := auth.uid();
  v_status TEXT;
  v_reversal_id UUID;
  v_previous TEXT := current_setting('app.shortcut_match_reversal', true);
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_inbox_item_id IS NULL OR p_decision_id IS NULL THEN
    RAISE EXCEPTION 'Inbox item and match decision are required' USING ERRCODE = '22023';
  END IF;
  -- This row lock serializes reversal, reassignment, and ordinary review.
  SELECT status INTO v_status FROM public.shortcut_inbox_items
    WHERE id = p_inbox_item_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inbox item not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.shortcut_inbox_match_decisions
    WHERE id = p_decision_id AND inbox_item_id = p_inbox_item_id
      AND user_id = v_user AND decision_type = 'matched';
  IF NOT FOUND THEN RAISE EXCEPTION 'Existing match not found' USING ERRCODE = 'P0002'; END IF;
  SELECT id INTO v_reversal_id FROM public.shortcut_inbox_match_reversals
    WHERE decision_id = p_decision_id;
  IF FOUND THEN RETURN v_reversal_id; END IF;
  IF v_status <> 'matched' THEN
    RAISE EXCEPTION 'Inbox item is not matched' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.shortcut_inbox_match_reversals(user_id,inbox_item_id,decision_id)
    VALUES(v_user,p_inbox_item_id,p_decision_id) RETURNING id INTO v_reversal_id;
  PERFORM set_config('app.shortcut_match_reversal','on',true);
  UPDATE public.shortcut_inbox_items SET status='pending'
    WHERE id=p_inbox_item_id AND user_id=v_user;
  PERFORM set_config('app.shortcut_match_reversal',coalesce(v_previous,''),true);
  RETURN v_reversal_id;
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_shortcut_match(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_shortcut_match(UUID,UUID) TO authenticated;

-- A hard delete erases snapshots for that transaction only. A historical,
-- already-reversed match must not reset a later active match to pending.
CREATE OR REPLACE FUNCTION public.erase_shortcut_matches_for_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_previous TEXT := current_setting('app.shortcut_match_erasure', true);
BEGIN
  PERFORM set_config('app.shortcut_match_erasure','on',true);
  UPDATE public.shortcut_inbox_items SET status='pending'
    WHERE user_id=OLD.user_id AND id IN (
      SELECT d.inbox_item_id FROM public.shortcut_inbox_match_decisions d
      WHERE d.user_id=OLD.user_id AND d.transaction_id=OLD.id
        AND NOT EXISTS(SELECT 1 FROM public.shortcut_inbox_match_reversals r
          WHERE r.decision_id=d.id)
    );
  DELETE FROM public.shortcut_inbox_match_decisions
    WHERE user_id=OLD.user_id AND transaction_id=OLD.id;
  PERFORM set_config('app.shortcut_match_erasure',coalesce(v_previous,''),true);
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_shortcut_match(
  p_inbox_item_id UUID, p_transaction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_inbox RECORD;
  v_transaction RECORD;
  v_existing RECORD;
  v_decision_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_inbox_item_id IS NULL OR p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Inbox item and transaction are required' USING ERRCODE = '22023';
  END IF;

  -- The inbox lock serializes retries and competing choices for this item.
  SELECT id, status INTO v_inbox
  FROM public.shortcut_inbox_items
  WHERE id = p_inbox_item_id AND user_id = v_user
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbox item not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, transaction_id, decision_type INTO v_existing
  FROM public.shortcut_inbox_match_decisions
  WHERE inbox_item_id = p_inbox_item_id AND user_id = v_user
    AND NOT EXISTS (SELECT 1 FROM public.shortcut_inbox_match_reversals r
      WHERE r.decision_id = shortcut_inbox_match_decisions.id);
  IF FOUND THEN
    IF v_inbox.status = 'matched' AND v_existing.decision_type = 'matched'
      AND v_existing.transaction_id = p_transaction_id THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'Inbox item already matched to another transaction' USING ERRCODE = '23505';
  END IF;
  IF v_inbox.status <> 'pending' THEN
    RAISE EXCEPTION 'Inbox item is not pending review' USING ERRCODE = '23514';
  END IF;

  -- A stale retry of an undone match must not silently reinstate it.
  IF EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_decisions d
    JOIN public.shortcut_inbox_match_reversals r ON r.decision_id = d.id
    WHERE d.inbox_item_id = p_inbox_item_id AND d.user_id = v_user
      AND d.transaction_id = p_transaction_id
  ) THEN
    RAISE EXCEPTION 'Previously reversed match requires another review choice'
      USING ERRCODE = '23514';
  END IF;

  -- FOR SHARE prevents a concurrent soft delete before this decision commits.
  SELECT id, amount, date, description, account_id, type, source
  INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active transaction not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.shortcut_inbox_match_decisions (
    user_id, inbox_item_id, transaction_id, transaction_snapshot
  ) VALUES (
    v_user, p_inbox_item_id, p_transaction_id,
    jsonb_build_object('id', v_transaction.id, 'amount', v_transaction.amount,
      'date', v_transaction.date, 'description', v_transaction.description,
      'account_id', v_transaction.account_id, 'type', v_transaction.type,
      'source', v_transaction.source)
  ) RETURNING id INTO v_decision_id;

  UPDATE public.shortcut_inbox_items SET status = 'matched'
  WHERE id = p_inbox_item_id AND user_id = v_user;
  RETURN v_decision_id;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_shortcut_match(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_shortcut_match(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_shortcut_transaction(
  p_inbox_item_id UUID,
  p_reviewed_payload JSONB,
  p_reviewed_candidate_hash TEXT,
  p_confirm_distinct BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_inbox public.shortcut_inbox_items%ROWTYPE;
  v_existing public.shortcut_inbox_match_decisions%ROWTYPE;
  v_account_id UUID;
  v_category_id UUID;
  v_amount NUMERIC(15,2);
  v_date DATE;
  v_type TEXT;
  v_description TEXT;
  v_candidates JSONB;
  v_candidate_count INTEGER;
  v_candidate_hash TEXT;
  v_transaction_id UUID;
  v_decision_id UUID;
  -- Match the UTC month used by web, Worker, and atomic CSV import counters.
  v_month TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used INTEGER;
  v_limit INTEGER;
  v_plan TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_inbox_item_id IS NULL OR jsonb_typeof(p_reviewed_payload) <> 'object'
    OR p_reviewed_candidate_hash IS NULL OR p_confirm_distinct IS NULL THEN
    RAISE EXCEPTION 'Invalid Shortcut review' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_reviewed_payload)) <> 6
    OR p_reviewed_payload ?& ARRAY['account_id','category_id','type','amount','date','description'] IS FALSE
    OR coalesce(p_reviewed_payload->>'amount','') !~ '^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$'
    OR coalesce(p_reviewed_payload->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(p_reviewed_payload->>'type','') NOT IN ('expense','income')
    OR length(btrim(coalesce(p_reviewed_payload->>'description',''))) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(p_reviewed_payload->'amount') <> 'string'
    OR jsonb_typeof(p_reviewed_payload->'description') <> 'string' THEN
    RAISE EXCEPTION 'Invalid reviewed transaction fields' USING ERRCODE = '22023';
  END IF;

  v_account_id := (p_reviewed_payload->>'account_id')::UUID;
  v_category_id := (p_reviewed_payload->>'category_id')::UUID;
  v_amount := (p_reviewed_payload->>'amount')::NUMERIC(15,2);
  v_date := (p_reviewed_payload->>'date')::DATE;
  v_type := p_reviewed_payload->>'type';
  v_description := btrim(p_reviewed_payload->>'description');
  IF v_amount <= 0 OR to_char(v_date, 'YYYY-MM-DD') <> p_reviewed_payload->>'date' THEN
    RAISE EXCEPTION 'Invalid amount or date' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inbox FROM public.shortcut_inbox_items
    WHERE id = p_inbox_item_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inbox item not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_existing FROM public.shortcut_inbox_match_decisions
    WHERE inbox_item_id = p_inbox_item_id AND user_id = v_user
      AND NOT EXISTS (SELECT 1 FROM public.shortcut_inbox_match_reversals r
        WHERE r.decision_id = shortcut_inbox_match_decisions.id);
  IF FOUND THEN
    IF v_existing.decision_type = 'created'
      AND v_existing.reviewed_payload = p_reviewed_payload THEN
      RETURN jsonb_build_object('status','created','transaction_id',v_existing.transaction_id,
        'decision_id',v_existing.id,'replayed',true);
    END IF;
    RAISE EXCEPTION 'Inbox item already has another decision' USING ERRCODE = '23505';
  END IF;
  IF v_inbox.status <> 'pending' THEN
    RAISE EXCEPTION 'Inbox item is not pending review' USING ERRCODE = '23514';
  END IF;

  -- The account lock conflicts with a transaction insert's foreign-key lock.
  -- Rechecking candidates under this lock closes the duplicate-preview race.
  PERFORM 1 FROM public.accounts WHERE id = v_account_id AND user_id = v_user
    AND is_active AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.categories WHERE id = v_category_id AND user_id = v_user
    AND type = v_type AND is_active AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category not found for type' USING ERRCODE = 'P0002'; END IF;

  -- Same amount/date/account is a review signal, never an automatic duplicate.
  -- Exact original text is also a signal even if the reviewed fields differ.
  WITH locked_candidates AS (
    SELECT id, date, amount, account_id, description, source
      FROM public.transactions
      WHERE user_id = v_user AND deleted_at IS NULL
        AND ((account_id = v_account_id AND date = v_date AND amount = v_amount)
          OR raw_text = v_inbox.raw_text)
      ORDER BY id LIMIT 21 FOR SHARE
  ), candidates AS (
    SELECT *, row_number() OVER (ORDER BY id) AS position FROM locked_candidates
  )
  SELECT count(*)::INTEGER,
    coalesce(jsonb_agg(jsonb_build_object('id',id,'date',date,'amount',amount::TEXT,
      'account_id',account_id,'description',description,'source',source) ORDER BY id)
      FILTER (WHERE position <= 20), '[]'::JSONB)
    INTO v_candidate_count, v_candidates FROM candidates;
  v_candidate_hash := md5(v_candidates::TEXT);
  IF v_candidate_count > 20 THEN
    RETURN jsonb_build_object('status','review_overflow','candidates',v_candidates,
      'candidate_count',v_candidate_count);
  END IF;
  IF v_candidate_count > 0 AND
    (NOT p_confirm_distinct OR p_reviewed_candidate_hash <> v_candidate_hash) THEN
    RETURN jsonb_build_object('status','review_required','candidates',v_candidates,
      'candidate_hash',v_candidate_hash,'candidate_count',v_candidate_count);
  END IF;

  INSERT INTO public.usage_tracking(user_id, month) VALUES(v_user, v_month)
    ON CONFLICT(user_id, month) DO NOTHING;
  SELECT transactions_count INTO v_used FROM public.usage_tracking
    WHERE user_id = v_user AND month = v_month FOR UPDATE;
  SELECT plan INTO v_plan FROM public.subscriptions
    WHERE user_id = v_user AND status = 'active';
  IF coalesce(v_plan,'free') = 'free' THEN
    SELECT coalesce((SELECT value::INTEGER FROM public.app_settings
      WHERE key = 'free_transactions_limit'), 50) INTO v_limit;
    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Transaction limit exceeded' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.transactions(user_id,date,time,amount,description,type,source,
      account_id,category_id,raw_text,parsed_data)
    VALUES(v_user,v_date,(v_inbox.received_at AT TIME ZONE 'America/Bogota')::TIME,
      v_amount,v_description,v_type,'shortcut_inbox',v_account_id,v_category_id,
      v_inbox.raw_text,jsonb_build_object('shortcut_inbox_item_id',v_inbox.id,
        'shortcut_source',v_inbox.source,'shortcut_external_id',v_inbox.external_id,
        'shortcut_idempotency_key',v_inbox.idempotency_key,
        'shortcut_received_at',v_inbox.received_at))
    RETURNING id INTO v_transaction_id;

  UPDATE public.accounts SET balance = coalesce(balance,0) +
    CASE WHEN v_type = 'expense' THEN -v_amount ELSE v_amount END
    WHERE id = v_account_id AND user_id = v_user;
  UPDATE public.usage_tracking SET transactions_count = transactions_count + 1,
    updated_at = now() WHERE user_id = v_user AND month = v_month;

  INSERT INTO public.shortcut_inbox_match_decisions(user_id,inbox_item_id,transaction_id,
      transaction_snapshot,decision_type,reviewed_payload,candidate_hash)
    VALUES(v_user,v_inbox.id,v_transaction_id,jsonb_build_object(
      'id',v_transaction_id,'amount',v_amount,'date',v_date,'description',v_description,
      'account_id',v_account_id,'category_id',v_category_id,'type',v_type,
      'source','shortcut_inbox','received_at',v_inbox.received_at),
      'created',p_reviewed_payload,v_candidate_hash)
    RETURNING id INTO v_decision_id;
  UPDATE public.shortcut_inbox_items SET status = 'created'
    WHERE id = v_inbox.id AND user_id = v_user;
  RETURN jsonb_build_object('status','created','transaction_id',v_transaction_id,
    'decision_id',v_decision_id,'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_shortcut_transaction(UUID, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_shortcut_transaction(UUID, JSONB, TEXT, BOOLEAN)
  TO authenticated;
