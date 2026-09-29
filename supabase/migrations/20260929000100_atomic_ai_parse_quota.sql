-- Reserve one AI request for a user. The row-level UPDATE serializes concurrent
-- text and vision requests so a free plan cannot exceed its configured count.
CREATE FUNCTION public.reserve_ai_parse(p_user_id uuid)
RETURNS TABLE (allowed boolean, used integer, "limit" integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_month text := to_char(timezone('UTC', now()), 'YYYY-MM');
  v_free_limit integer;
  v_transaction_limit integer;
  v_is_pro boolean;
  v_used integer;
BEGIN
  SELECT greatest(0, coalesce((s.value #>> '{}')::integer, 15))
  INTO v_free_limit
  FROM public.app_settings AS s
  WHERE s.key = 'free_ai_parses_limit';
  v_free_limit := coalesce(v_free_limit, 15);

  SELECT greatest(0, coalesce((s.value #>> '{}')::integer, 50))
  INTO v_transaction_limit
  FROM public.app_settings AS s
  WHERE s.key = 'free_transactions_limit';
  v_transaction_limit := coalesce(v_transaction_limit, 50);

  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions AS s
    WHERE s.user_id = p_user_id AND s.plan = 'pro' AND s.status = 'active'
  ) INTO v_is_pro;

  INSERT INTO public.usage_tracking (
    user_id, month, ai_parses_used, ai_parses_limit,
    transactions_count, transactions_limit
  ) VALUES (
    p_user_id, v_month, 0, v_free_limit, 0, v_transaction_limit
  ) ON CONFLICT (user_id, month) DO NOTHING;

  UPDATE public.usage_tracking AS u
  SET ai_parses_used = u.ai_parses_used + 1,
      updated_at = now()
  WHERE u.user_id = p_user_id
    AND u.month = v_month
    AND (v_is_pro OR u.ai_parses_used < v_free_limit)
  RETURNING u.ai_parses_used INTO v_used;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_used, CASE WHEN v_is_pro THEN -1 ELSE v_free_limit END;
    RETURN;
  END IF;

  SELECT u.ai_parses_used INTO v_used
  FROM public.usage_tracking AS u
  WHERE u.user_id = p_user_id AND u.month = v_month;

  RETURN QUERY SELECT false, v_used, v_free_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_ai_parse(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ai_parse(uuid) TO service_role;

-- Browser transaction creation still writes transactions_count and may create
-- a monthly row. It must not reset the AI request counter or delete that row.
CREATE FUNCTION public.reject_nonzero_client_ai_counter()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.ai_parses_used <> 0 THEN
    RAISE EXCEPTION 'AI parse counter must start at zero' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reject_nonzero_client_ai_counter
BEFORE INSERT ON public.usage_tracking
FOR EACH ROW EXECUTE FUNCTION public.reject_nonzero_client_ai_counter();

REVOKE UPDATE, DELETE ON public.usage_tracking FROM PUBLIC, anon, authenticated;
GRANT UPDATE (transactions_count, updated_at) ON public.usage_tracking TO authenticated;

-- The active pro plan bypasses the count limit, so clients may read their
-- subscription but only trusted billing/server code may change its plan.
REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM PUBLIC, anon, authenticated;

-- TRUNCATE and REFERENCES are outside RLS. Remove any legacy broad grants;
-- clients also have no reason to attach triggers to either counter source.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.usage_tracking, public.subscriptions
  FROM PUBLIC, anon, authenticated;
