-- Confirm one manual transaction with its balance and UTC usage count in one transaction.
-- Run after 20260929000120_shortcut_match_reversal.sql.
CREATE TABLE public.manual_transaction_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX manual_transaction_requests_transaction_id_idx
  ON public.manual_transaction_requests(transaction_id);
ALTER TABLE public.manual_transaction_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.manual_transaction_requests FROM PUBLIC, anon, authenticated;
-- Mobile offline sync still upserts transactions as authenticated. Keep that
-- grant until its push path moves to a compatible owner-scoped RPC.
-- Earlier browser routes could edit the monthly transaction counter. All
-- current creation paths use trusted RPCs or service_role, so close that bypass.
REVOKE INSERT, UPDATE, DELETE ON public.usage_tracking FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (transactions_count, updated_at) ON public.usage_tracking
  FROM anon, authenticated;

CREATE FUNCTION public.confirm_manual_transaction(
  p_request_id uuid,
  p_payload jsonb,
  p_force boolean,
  p_replace_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_month text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_hash text;
  v_existing public.manual_transaction_requests%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_new public.transactions%ROWTYPE;
  v_match public.transactions%ROWTYPE;
  v_account uuid;
  v_to_account uuid;
  v_category uuid;
  v_duplicate_of uuid;
  v_lock_account uuid;
  v_amount numeric(15,2);
  v_date date;
  v_time time;
  v_type text;
  v_used integer;
  v_limit integer;
  v_is_pro boolean;
  v_delta integer := CASE WHEN p_replace_id IS NULL THEN 1 ELSE 0 END;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR p_force IS NULL THEN
    RAISE EXCEPTION 'Invalid transaction request' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object('payload',p_payload,'force',p_force,
    'replace_id',p_replace_id)::text);

  -- Serialize manual requests for this owner, including retries and exact-text
  -- duplicates that use different accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.manual_transaction_requests
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different payload' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_new FROM public.transactions
      WHERE id = v_existing.transaction_id AND user_id = v_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Previously created transaction was erased' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object('status','created','transaction',to_jsonb(v_new),'replayed',true);
  END IF;

  IF jsonb_typeof(p_payload->'date') <> 'string'
    OR jsonb_typeof(p_payload->'time') <> 'string'
    OR jsonb_typeof(p_payload->'amount') <> 'number'
    OR jsonb_typeof(p_payload->'description') <> 'string'
    OR jsonb_typeof(p_payload->'account_id') <> 'string'
    OR jsonb_typeof(p_payload->'type') <> 'string'
    OR jsonb_typeof(p_payload->'source') <> 'string'
    OR coalesce(p_payload->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(p_payload->>'time','') !~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$'
    OR coalesce(p_payload->>'type','') NOT IN ('expense','income','transfer')
    OR length(btrim(coalesce(p_payload->>'description',''))) = 0
    OR length(coalesce(p_payload->>'source','')) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Invalid transaction fields' USING ERRCODE = '22023';
  END IF;
  v_date := (p_payload->>'date')::date;
  v_time := (p_payload->>'time')::time;
  v_amount := (p_payload->>'amount')::numeric(15,2);
  v_type := p_payload->>'type';
  IF to_char(v_date,'YYYY-MM-DD') <> p_payload->>'date' OR v_amount <= 0
    OR (p_payload->>'amount')::numeric <> v_amount THEN
    RAISE EXCEPTION 'Invalid amount or date' USING ERRCODE = '22023';
  END IF;
  v_account := (p_payload->>'account_id')::uuid;
  v_to_account := nullif(p_payload->>'transfer_to_account_id','')::uuid;
  v_category := nullif(p_payload->>'category_id','')::uuid;
  v_duplicate_of := nullif(p_payload->>'duplicate_of','')::uuid;
  IF (v_type = 'transfer' AND (v_to_account IS NULL OR v_to_account = v_account))
    OR (v_type <> 'transfer' AND v_to_account IS NOT NULL) THEN
    RAISE EXCEPTION 'Transfer destination must be distinct and present only for transfers'
      USING ERRCODE = '22023';
  END IF;

  IF p_replace_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.transactions
      WHERE id = p_replace_id AND user_id = v_user AND deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Replacement transaction not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Match the CSV and Shortcut lock order: accounts first, then monthly usage.
  FOR v_lock_account IN
    SELECT DISTINCT id FROM unnest(ARRAY[v_account,v_to_account,
      v_old.account_id,v_old.transfer_to_account_id]) AS id
      WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM 1 FROM public.accounts
      WHERE id = v_lock_account AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = v_account AND user_id = v_user
    AND is_active AND deleted_at IS NULL)
    OR (v_to_account IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounts WHERE id = v_to_account AND user_id = v_user
        AND is_active AND deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Account is inactive or deleted' USING ERRCODE = '23514';
  END IF;
  IF v_category IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.categories WHERE id = v_category AND user_id = v_user
      AND type = v_type AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Category does not belong to caller or match transaction type'
      USING ERRCODE = '42501';
  END IF;
  IF v_duplicate_of IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transactions WHERE id = v_duplicate_of AND user_id = v_user) THEN
    RAISE EXCEPTION 'Duplicate reference does not belong to caller' USING ERRCODE = '42501';
  END IF;
  IF p_replace_id IS NOT NULL THEN
    PERFORM 1 FROM public.transactions WHERE id = p_replace_id AND user_id = v_user
      AND deleted_at IS NULL AND account_id = v_old.account_id
      AND transfer_to_account_id IS NOT DISTINCT FROM v_old.transfer_to_account_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Replacement transaction changed during review' USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.usage_tracking(user_id,month)
    VALUES(v_user,v_month) ON CONFLICT(user_id,month) DO NOTHING;
  SELECT transactions_count INTO v_used FROM public.usage_tracking
    WHERE user_id = v_user AND month = v_month FOR UPDATE;
  IF NOT p_force AND p_replace_id IS NULL THEN
    IF nullif(p_payload->>'raw_text','') IS NOT NULL THEN
      SELECT * INTO v_match FROM public.transactions
        WHERE user_id = v_user AND deleted_at IS NULL
          AND raw_text = p_payload->>'raw_text' AND source = p_payload->>'source'
        ORDER BY id LIMIT 1;
    END IF;
    IF v_match.id IS NULL THEN
      SELECT * INTO v_match FROM public.transactions
        WHERE user_id = v_user AND deleted_at IS NULL
          AND date = v_date AND amount = v_amount AND account_id = v_account
        ORDER BY id LIMIT 1;
    END IF;
    IF v_match.id IS NOT NULL THEN
      RETURN jsonb_build_object('status','duplicate','match',to_jsonb(v_match));
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = v_user
    AND plan = 'pro' AND status = 'active') INTO v_is_pro;
  IF NOT v_is_pro THEN
    SELECT coalesce((SELECT value::integer FROM public.app_settings
      WHERE key = 'free_transactions_limit'),50) INTO v_limit;
    IF v_used + v_delta > v_limit THEN
      RAISE EXCEPTION 'Transaction limit exceeded' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_replace_id IS NOT NULL THEN
    UPDATE public.transactions SET deleted_at = now() WHERE id = v_old.id AND user_id = v_user;
    IF v_old.type = 'expense' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
    ELSIF v_old.type = 'income' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
    ELSIF v_old.type = 'transfer' AND v_old.transfer_to_account_id IS NOT NULL THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_old.amount
        WHERE id = v_old.transfer_to_account_id AND user_id = v_user;
    END IF;
  END IF;

  INSERT INTO public.transactions(user_id,date,time,amount,description,notes,category_id,
    account_id,type,payment_method,source,confidence,transfer_to_account_id,
    transfer_id,raw_text,parsed_data,applied_rules,duplicate_status,duplicate_of)
  VALUES(v_user,v_date,v_time,v_amount,p_payload->>'description',p_payload->>'notes',
    v_category,v_account,v_type,p_payload->>'payment_method',p_payload->>'source',
    nullif(p_payload->>'confidence','')::integer,v_to_account,
    nullif(p_payload->>'transfer_id','')::uuid,p_payload->>'raw_text',
    p_payload->'parsed_data',p_payload->'applied_rules',
    CASE WHEN p_force THEN 'confirmed' ELSE p_payload->>'duplicate_status' END,
    v_duplicate_of)
  RETURNING * INTO v_new;

  IF v_type = 'expense' THEN
    UPDATE public.accounts SET balance = coalesce(balance,0) - v_amount
      WHERE id = v_account AND user_id = v_user;
  ELSIF v_type = 'income' THEN
    UPDATE public.accounts SET balance = coalesce(balance,0) + v_amount
      WHERE id = v_account AND user_id = v_user;
  ELSIF v_type = 'transfer' AND v_to_account IS NOT NULL THEN
    UPDATE public.accounts SET balance = coalesce(balance,0) - v_amount
      WHERE id = v_account AND user_id = v_user;
    UPDATE public.accounts SET balance = coalesce(balance,0) + v_amount
      WHERE id = v_to_account AND user_id = v_user;
  END IF;
  UPDATE public.usage_tracking SET transactions_count = transactions_count + v_delta,
    updated_at = now() WHERE user_id = v_user AND month = v_month;
  INSERT INTO public.manual_transaction_requests(user_id,request_id,request_hash,transaction_id)
    VALUES(v_user,p_request_id,v_hash,v_new.id);
  RETURN jsonb_build_object('status','created','transaction',to_jsonb(v_new),'replayed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_manual_transaction(uuid,jsonb,boolean,uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_manual_transaction(uuid,jsonb,boolean,uuid)
  TO authenticated;
