-- Keep automatic decisions distinguishable from owner-reviewed Shortcut decisions.
CREATE TABLE public.forwarded_email_auto_posts (
  inbox_item_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  transaction_id uuid UNIQUE,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (transaction_id)
);

CREATE INDEX forwarded_email_auto_posts_user_created_idx
  ON public.forwarded_email_auto_posts(user_id, created_at DESC);

ALTER TABLE public.forwarded_email_auto_posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY forwarded_email_auto_posts_select_owner ON public.forwarded_email_auto_posts
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.forwarded_email_auto_posts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.forwarded_email_auto_posts TO authenticated;
GRANT SELECT ON public.forwarded_email_auto_posts TO service_role;

CREATE FUNCTION public.auto_post_verified_forwarded_purchase(
  p_user_id uuid,
  p_inbox_item_id uuid,
  p_account_id uuid,
  p_category_id uuid,
  p_amount numeric(15,2),
  p_date date,
  p_time time,
  p_card_last_four text,
  p_description text,
  p_model text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inbox public.shortcut_inbox_items%ROWTYPE;
  v_existing public.forwarded_email_auto_posts%ROWTYPE;
  v_event_at timestamptz;
  v_amount_text text;
  v_payload jsonb;
  v_transaction_id uuid;
  v_decision_id uuid;
  v_month text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used integer;
  v_limit integer;
  v_plan text;
BEGIN
  IF p_user_id IS NULL OR p_inbox_item_id IS NULL OR p_account_id IS NULL
    OR p_category_id IS NULL OR p_amount IS NULL OR p_amount <= 0
    OR p_date IS NULL OR p_time IS NULL OR p_card_last_four !~ '^\d{4}$'
    OR length(btrim(coalesce(p_description, ''))) NOT BETWEEN 3 AND 500
    OR p_description NOT LIKE 'Compra en %'
    OR length(btrim(coalesce(p_model, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid automatic purchase' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_inbox FROM public.shortcut_inbox_items
    WHERE id = p_inbox_item_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND OR v_inbox.source <> 'forwarded_email' THEN
    RAISE EXCEPTION 'Forwarded inbox item not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_existing FROM public.forwarded_email_auto_posts
    WHERE inbox_item_id = p_inbox_item_id AND user_id = p_user_id;
  IF FOUND THEN
    IF v_existing.transaction_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.transactions WHERE id = v_existing.transaction_id
        AND user_id = p_user_id AND deleted_at IS NULL
    ) THEN
      RETURN jsonb_build_object('status','created','transaction_id',v_existing.transaction_id,
        'replayed',true);
    END IF;
    RETURN jsonb_build_object('status','review_required');
  END IF;
  IF v_inbox.status <> 'pending' THEN
    RETURN jsonb_build_object('status','review_required');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.email_forwarding_routes
    WHERE user_id = p_user_id AND confirmation_received_at IS NOT NULL
      AND user_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Forwarding route is not verified' USING ERRCODE = '23514';
  END IF;
  -- The account lock serializes financial writes with the duplicate check below.
  PERFORM 1 FROM public.accounts
    WHERE id = p_account_id AND user_id = p_user_id AND type = 'credit_card'
      AND lower(coalesce(institution, '')) LIKE '%lulo%'
      AND last_four = p_card_last_four AND currency = 'COP'
      AND is_active AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Matching COP card account not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.categories WHERE id = p_category_id AND user_id = p_user_id
      AND type = 'expense' AND is_active AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inbox.raw_text NOT ILIKE '%notificaciones@lulobank.com%'
    OR v_inbox.raw_text NOT ILIKE '%Compra realizada%'
    OR (position('•' || p_card_last_four in v_inbox.raw_text) = 0
      AND position('*' || p_card_last_four in v_inbox.raw_text) = 0)
    OR position(lower(substr(p_description, 11)) in lower(v_inbox.raw_text)) = 0 THEN
    RAISE EXCEPTION 'Inbox evidence does not match purchase' USING ERRCODE = '23514';
  END IF;
  v_amount_text := substring(v_inbox.raw_text from
    'Realizaste una compra en [^\n]+ por (?:COP[[:space:]]*)?\$[[:space:]]*([0-9,]+(?:\.[0-9]{1,2})?)');
  IF v_amount_text IS NULL OR replace(v_amount_text, ',', '')::numeric <> p_amount THEN
    RAISE EXCEPTION 'Posted amount differs from inbox evidence' USING ERRCODE = '23514';
  END IF;

  v_event_at := (p_date::text || ' ' || p_time::text || '-05:00')::timestamptz;
  IF v_event_at > v_inbox.received_at + interval '5 minutes'
    OR v_event_at < v_inbox.received_at - interval '31 days' THEN
    RAISE EXCEPTION 'Purchase time conflicts with receipt' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.transactions WHERE user_id = p_user_id AND deleted_at IS NULL
      AND ((account_id = p_account_id AND date = p_date AND amount = p_amount)
        OR raw_text = v_inbox.raw_text)
    LIMIT 1 FOR SHARE
  ) THEN
    RETURN jsonb_build_object('status','review_required');
  END IF;

  INSERT INTO public.usage_tracking(user_id, month) VALUES(p_user_id, v_month)
    ON CONFLICT(user_id, month) DO NOTHING;
  SELECT transactions_count INTO v_used FROM public.usage_tracking
    WHERE user_id = p_user_id AND month = v_month FOR UPDATE;
  SELECT plan INTO v_plan FROM public.subscriptions
    WHERE user_id = p_user_id AND status = 'active';
  IF coalesce(v_plan, 'free') = 'free' THEN
    SELECT coalesce((SELECT value::integer FROM public.app_settings
      WHERE key = 'free_transactions_limit'), 50) INTO v_limit;
    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Transaction limit exceeded' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_payload := jsonb_build_object(
    'account_id',p_account_id,'category_id',p_category_id,'type','expense',
    'amount',p_amount::text,'date',p_date::text,'description',btrim(p_description),
    'automated',true,'event_at',v_event_at,'model',p_model
  );
  INSERT INTO public.transactions(user_id,date,time,amount,description,type,source,
      account_id,category_id,raw_text,parsed_data)
    VALUES(p_user_id,p_date,p_time,p_amount,btrim(p_description),'expense','shortcut_inbox',
      p_account_id,p_category_id,v_inbox.raw_text,
      jsonb_build_object('shortcut_inbox_item_id',v_inbox.id,
        'shortcut_source',v_inbox.source,'shortcut_external_id',v_inbox.external_id,
        'shortcut_idempotency_key',v_inbox.idempotency_key,
        'shortcut_received_at',v_inbox.received_at,
        'email_auto_post',true,'email_event_at',v_event_at,
        'email_auto_model',p_model))
    RETURNING id INTO v_transaction_id;
  UPDATE public.accounts SET balance = coalesce(balance,0) - p_amount
    WHERE id = p_account_id AND user_id = p_user_id;
  UPDATE public.usage_tracking SET transactions_count = transactions_count + 1,
    updated_at = now() WHERE user_id = p_user_id AND month = v_month;

  INSERT INTO public.shortcut_inbox_match_decisions(user_id,inbox_item_id,transaction_id,
      transaction_snapshot,decision_type,reviewed_payload,candidate_hash)
    VALUES(p_user_id,v_inbox.id,v_transaction_id,jsonb_build_object(
      'id',v_transaction_id,'amount',p_amount,'date',p_date,
      'description',btrim(p_description),'account_id',p_account_id,
      'category_id',p_category_id,'type','expense','source','shortcut_inbox',
      'received_at',v_inbox.received_at,'event_at',v_event_at,
      'automated',true),'created',v_payload,md5('[]'))
    RETURNING id INTO v_decision_id;
  INSERT INTO public.forwarded_email_auto_posts(inbox_item_id,user_id,transaction_id,model)
    VALUES (p_inbox_item_id,p_user_id,v_transaction_id,p_model);
  UPDATE public.shortcut_inbox_items SET status = 'created'
    WHERE id = v_inbox.id AND user_id = p_user_id;
  RETURN jsonb_build_object('status','created','transaction_id',v_transaction_id,
    'decision_id',v_decision_id,'replayed',false);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_post_verified_forwarded_purchase(
  uuid,uuid,uuid,uuid,numeric,date,time,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_post_verified_forwarded_purchase(
  uuid,uuid,uuid,uuid,numeric,date,time,text,text,text
) TO service_role;
