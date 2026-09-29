-- Reviewed Shortcut creation uses the existing owner-scoped inbox and audit link.
-- Run after 20260929000080_shortcut_match_ack.sql.
ALTER TABLE public.shortcut_inbox_items
  DROP CONSTRAINT shortcut_inbox_items_status_check;
ALTER TABLE public.shortcut_inbox_items
  ADD CONSTRAINT shortcut_inbox_items_status_check
  CHECK (status IN ('pending', 'non_transaction', 'dismissed', 'matched', 'created'));

ALTER TABLE public.shortcut_inbox_match_decisions
  ADD COLUMN decision_type TEXT NOT NULL DEFAULT 'matched'
    CHECK (decision_type IN ('matched', 'created')),
  ADD COLUMN reviewed_payload JSONB,
  ADD COLUMN candidate_hash TEXT;
ALTER TABLE public.shortcut_inbox_match_decisions
  ADD CONSTRAINT shortcut_created_review_check
  CHECK (decision_type <> 'created' OR reviewed_payload IS NOT NULL);

CREATE OR REPLACE FUNCTION public.guard_shortcut_match_status()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('matched', 'created') AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (current_user = 'postgres'
      AND current_setting('app.shortcut_match_erasure', true) = 'on'
      AND pg_trigger_depth() > 1) THEN
    RAISE EXCEPTION 'Reviewed inbox status is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('matched', 'created') AND OLD.status IS DISTINCT FROM NEW.status
    AND NOT EXISTS (
      SELECT 1 FROM public.shortcut_inbox_match_decisions
      WHERE inbox_item_id = NEW.id AND user_id = NEW.user_id
        AND decision_type = NEW.status
    ) THEN
    RAISE EXCEPTION 'Reviewed status requires a matching decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.confirm_shortcut_transaction(
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
  -- Match current web and Worker usage counters. CSV import differs until unified.
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
    WHERE inbox_item_id = p_inbox_item_id AND user_id = v_user;
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
