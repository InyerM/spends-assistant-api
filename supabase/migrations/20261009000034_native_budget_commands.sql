-- Retry native offline budget commands without duplicating category changes or edit history.
CREATE TABLE public.native_budget_commands (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
ALTER TABLE public.native_budget_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.native_budget_commands FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.apply_native_budget_command(p_request_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_previous public.native_budget_commands%ROWTYPE;
  v_budget uuid;
  v_month date;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR coalesce(p_payload->>'action', '') NOT IN ('create', 'update', 'stop')
    OR coalesce(p_payload->>'month', '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) AS key
      WHERE key NOT IN ('action','month','budget_id','category_id','limit_cop','repeat_monthly')) THEN
    RAISE EXCEPTION 'Invalid native budget command' USING ERRCODE = '22023';
  END IF;
  v_month := (p_payload->>'month')::date;
  v_hash := md5(p_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('native-budget:' || v_user::text, 0));
  SELECT * INTO v_previous FROM public.native_budget_commands
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_previous.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different payload' USING ERRCODE = '22023';
    END IF;
    RETURN v_previous.result || jsonb_build_object('replayed', true);
  END IF;
  IF p_payload->>'action' = 'stop' THEN
    v_budget := (p_payload->>'budget_id')::uuid;
    IF v_budget IS NULL OR NOT public.stop_monthly_budget(v_budget, v_month) THEN
      RAISE EXCEPTION 'Budget not found' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    IF jsonb_typeof(p_payload->'category_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_payload->'limit_cop') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_payload->'repeat_monthly') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid native budget fields' USING ERRCODE = '22023';
    END IF;
    IF p_payload->>'action' = 'create' THEN
      v_budget := public.create_monthly_budget(v_month, (p_payload->>'category_id')::uuid,
        (p_payload->>'limit_cop')::numeric, (p_payload->>'repeat_monthly')::boolean);
    ELSE
      v_budget := public.update_monthly_budget((p_payload->>'budget_id')::uuid, v_month,
        (p_payload->>'category_id')::uuid, (p_payload->>'limit_cop')::numeric,
        (p_payload->>'repeat_monthly')::boolean);
    END IF;
  END IF;
  v_result := jsonb_build_object('budget_id', v_budget, 'replayed', false,
    'records', (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.month, b.id), '[]'::jsonb)
      FROM public.monthly_budgets b WHERE b.user_id = v_user),
    'skips', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.month, s.budget_id), '[]'::jsonb)
      FROM public.monthly_budget_skips s WHERE s.user_id = v_user));
  INSERT INTO public.native_budget_commands(user_id, request_id, request_hash, result)
    VALUES (v_user, p_request_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_native_budget_command(uuid,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_native_budget_command(uuid,jsonb) TO authenticated;
