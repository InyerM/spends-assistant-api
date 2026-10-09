-- Set an owned account's target balance, recording the exact server-side difference.
CREATE TABLE public.account_balance_adjustments (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  previous_balance numeric(15,2) NOT NULL,
  target_balance numeric(15,2) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('manual', 'transaction')),
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.account_balance_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_balance_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_balance_adjustments TO authenticated;
CREATE POLICY account_balance_adjustments_owner_read ON public.account_balance_adjustments
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY terms_acceptance_required ON public.account_balance_adjustments
  AS RESTRICTIVE TO authenticated USING ((SELECT public.has_accepted_required_terms()));

CREATE FUNCTION public.adjust_account_balance(
  p_request_id uuid, p_account_id uuid, p_target numeric, p_mode text, p_source text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_account public.accounts%ROWTYPE;
  v_existing public.account_balance_adjustments%ROWTYPE;
  v_hash text;
  v_delta numeric;
  v_post jsonb;
  v_result jsonb;
  v_transaction_id uuid;
  v_event timestamp := now() AT TIME ZONE 'America/Bogota';
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Required terms must be accepted' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_account_id IS NULL OR p_target IS NULL
    OR p_target::text IN ('NaN', 'Infinity', '-Infinity')
    OR abs(p_target) > 9999999999999.99 OR round(p_target, 2) <> p_target
    OR p_mode IS NULL OR p_mode NOT IN ('manual', 'transaction')
    OR p_source IS NULL OR p_source NOT IN ('web', 'mobile') THEN
    RAISE EXCEPTION 'Invalid balance adjustment' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object('account_id', p_account_id, 'target', p_target::numeric(15,2),
    'mode', p_mode, 'source', p_source)::text);
  -- Match the manual posting lock order to serialize retries without a deadlock.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.account_balance_adjustments
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different payload' USING ERRCODE = '22023';
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_account FROM public.accounts
    WHERE id = p_account_id AND user_id = v_user AND deleted_at IS NULL AND is_active
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Owned active account not found' USING ERRCODE = 'P0002';
  END IF;
  v_delta := p_target - coalesce(v_account.balance, 0);
  IF abs(v_delta) > 9999999999999.99 AND p_mode = 'transaction' THEN
    RAISE EXCEPTION 'Adjustment exceeds transaction amount range' USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'transaction' AND v_delta <> 0 THEN
    v_post := public.confirm_manual_transaction(p_request_id, jsonb_build_object(
      'account_id', p_account_id, 'amount', abs(v_delta),
      'type', CASE WHEN v_delta > 0 THEN 'income' ELSE 'expense' END,
      'date', to_char(v_event, 'YYYY-MM-DD'), 'time', to_char(v_event, 'HH24:MI:SS'),
      'description', 'Balance adjustment', 'source', p_source), true, null);
    v_transaction_id := (v_post->'transaction'->>'id')::uuid;
    IF v_post->>'status' IS DISTINCT FROM 'created' OR v_transaction_id IS NULL THEN
      RAISE EXCEPTION 'Balance adjustment was not posted' USING ERRCODE = '23514';
    END IF;
  ELSIF p_mode = 'manual' AND v_delta <> 0 THEN
    UPDATE public.accounts SET balance = p_target, updated_at = now()
      WHERE id = p_account_id AND user_id = v_user;
  END IF;
  IF v_delta <> 0 THEN
    UPDATE public.accounts SET updated_at = now() WHERE id = p_account_id AND user_id = v_user;
  END IF;
  v_result := jsonb_build_object('account_id', p_account_id, 'balance', p_target,
    'previous_balance', coalesce(v_account.balance, 0), 'difference', v_delta,
    'transaction_id', v_transaction_id, 'replayed', false);
  INSERT INTO public.account_balance_adjustments(user_id, request_id, account_id,
    request_hash, previous_balance, target_balance, mode, transaction_id, result)
  VALUES(v_user, p_request_id, p_account_id, v_hash, coalesce(v_account.balance, 0),
    p_target, p_mode, v_transaction_id, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.adjust_account_balance(uuid,uuid,numeric,text,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_account_balance(uuid,uuid,numeric,text,text)
  TO authenticated;
