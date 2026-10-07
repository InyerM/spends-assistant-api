-- Preserve owner-reviewed notes in the transaction and audit snapshot.
-- Preserve an explicitly reviewed purchase time separately from immutable SMS receipt time.
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
  v_event_at TIMESTAMPTZ;
  v_event_at_text TEXT;
  v_type TEXT;
  v_description TEXT;
  v_notes TEXT;
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
  IF (SELECT count(*) FROM jsonb_object_keys(p_reviewed_payload)) NOT IN (6, 7, 8, 9)
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_reviewed_payload) AS field
      WHERE field NOT IN ('account_id','category_id','type','amount','date','description',
        'notes','event_at','event_time_confirmed'))
    OR p_reviewed_payload ?& ARRAY['account_id','category_id','type','amount','date','description'] IS FALSE
    OR coalesce(p_reviewed_payload->>'amount','') !~ '^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$'
    OR coalesce(p_reviewed_payload->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(p_reviewed_payload->>'type','') NOT IN ('expense','income')
    OR length(btrim(coalesce(p_reviewed_payload->>'description',''))) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(p_reviewed_payload->'amount') <> 'string'
    OR jsonb_typeof(p_reviewed_payload->'description') <> 'string'
    OR (p_reviewed_payload ? 'notes' AND (
      jsonb_typeof(p_reviewed_payload->'notes') <> 'string'
      OR length(btrim(p_reviewed_payload->>'notes')) > 2000)) THEN
    RAISE EXCEPTION 'Invalid reviewed transaction fields' USING ERRCODE = '22023';
  END IF;

  IF p_reviewed_payload ? 'event_at' OR p_reviewed_payload ? 'event_time_confirmed' THEN
    IF p_reviewed_payload ?& ARRAY['event_at','event_time_confirmed'] IS FALSE
      OR jsonb_typeof(p_reviewed_payload->'event_at') <> 'string'
      OR jsonb_typeof(p_reviewed_payload->'event_time_confirmed') <> 'boolean'
      OR p_reviewed_payload->'event_time_confirmed' <> 'true'::JSONB
      OR coalesce(p_reviewed_payload->>'event_at','') !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      RAISE EXCEPTION 'Invalid reviewed event time' USING ERRCODE = '22023';
    END IF;
    v_event_at_text := p_reviewed_payload->>'event_at';
    v_event_at := v_event_at_text::TIMESTAMPTZ;
  END IF;

  v_account_id := (p_reviewed_payload->>'account_id')::UUID;
  v_category_id := (p_reviewed_payload->>'category_id')::UUID;
  v_amount := (p_reviewed_payload->>'amount')::NUMERIC(15,2);
  v_date := (p_reviewed_payload->>'date')::DATE;
  v_type := p_reviewed_payload->>'type';
  v_description := btrim(p_reviewed_payload->>'description');
  v_notes := nullif(btrim(p_reviewed_payload->>'notes'), '');
  IF v_amount <= 0 OR to_char(v_date, 'YYYY-MM-DD') <> p_reviewed_payload->>'date' THEN
    RAISE EXCEPTION 'Invalid amount or date' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inbox FROM public.shortcut_inbox_items
    WHERE id = p_inbox_item_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inbox item not found' USING ERRCODE = 'P0002'; END IF;
  IF v_event_at IS NOT NULL AND (
    (v_event_at AT TIME ZONE 'America/Bogota')::DATE <> v_date
    OR v_event_at > v_inbox.received_at + INTERVAL '5 minutes'
    OR v_event_at < v_inbox.received_at - INTERVAL '31 days'
  ) THEN
    RAISE EXCEPTION 'Reviewed event time conflicts with date or receipt'
      USING ERRCODE = '22023';
  END IF;
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

  INSERT INTO public.transactions(user_id,date,time,amount,description,notes,type,source,
      account_id,category_id,raw_text,parsed_data)
    VALUES(v_user,v_date,coalesce((v_event_at AT TIME ZONE 'America/Bogota')::TIME,
      (v_inbox.received_at AT TIME ZONE 'America/Bogota')::TIME),
      v_amount,v_description,v_notes,v_type,'shortcut_inbox',v_account_id,v_category_id,
      v_inbox.raw_text,jsonb_build_object('shortcut_inbox_item_id',v_inbox.id,
        'shortcut_source',v_inbox.source,'shortcut_external_id',v_inbox.external_id,
        'shortcut_idempotency_key',v_inbox.idempotency_key,
        'shortcut_received_at',v_inbox.received_at) ||
        CASE WHEN v_event_at IS NULL THEN '{}'::JSONB
          ELSE jsonb_build_object('shortcut_event_at',v_event_at_text) END)
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
      'notes',v_notes,
      'account_id',v_account_id,'category_id',v_category_id,'type',v_type,
      'source','shortcut_inbox','received_at',v_inbox.received_at) ||
      CASE WHEN v_event_at IS NULL THEN '{}'::JSONB
        ELSE jsonb_build_object('event_at',v_event_at_text) END,
      'created',p_reviewed_payload,v_candidate_hash)
    RETURNING id INTO v_decision_id;
  UPDATE public.shortcut_inbox_items SET status = 'created'
    WHERE id = v_inbox.id AND user_id = v_user;
  RETURN jsonb_build_object('status','created','transaction_id',v_transaction_id,
    'decision_id',v_decision_id,'replayed',false);
END;
$$;
