-- Atomic, idempotent CSV import confirmation for the web application.
-- Run after 20241125000019_enable_realtime.sql.
-- One request ID identifies one immutable import attempt. A completed result is replayable.
ALTER TABLE public.imports ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.imports ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE public.imports ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS imports_user_request_id_unique
  ON public.imports(user_id, request_id) WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.confirm_csv_import(
  p_request_id uuid,
  p_payload jsonb,
  p_rows jsonb,
  p_reviews jsonb,
  p_file_name text,
  p_row_count integer,
  p_probe boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.imports%ROWTYPE;
  v_import_id uuid;
  v_account uuid;
  v_row jsonb;
  v_review jsonb;
  v_matches jsonb;
  v_duplicates jsonb := '[]'::jsonb;
  v_unreviewed jsonb := '[]'::jsonb;
  v_stale jsonb := '[]'::jsonb;
  v_index integer;
  v_imported integer := 0;
  v_skipped integer := 0;
  v_limit integer;
  v_used integer;
  v_plan text;
  v_month text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid import payload' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(p_payload::text);

  -- Serialize retries before consulting the durable request record.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_existing FROM public.imports
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different payload' USING ERRCODE = '22023';
    END IF;
    IF v_existing.status <> 'completed' THEN
      RAISE EXCEPTION 'Import request has an incomplete state' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('status', 'completed', 'imported', v_existing.imported_count,
      'skipped', v_existing.skipped_count, 'import_id', v_existing.id, 'replayed', true);
  END IF;
  IF p_probe THEN RETURN jsonb_build_object('status', 'new'); END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0
     OR jsonb_typeof(p_reviews) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid import payload' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_reviews) AS r(value)
    GROUP BY (r.value->>'index') HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate review index' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_reviews) AS r(value)
    WHERE (r.value->>'index')::integer < 0
      OR (r.value->>'index')::integer >= jsonb_array_length(p_rows)
      OR r.value->>'decision' IS NULL
      OR r.value->>'decision' NOT IN ('import', 'skip')
      OR jsonb_typeof(r.value->'match_ids') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'Invalid duplicate review' USING ERRCODE = '22023';
  END IF;

  -- A transaction insert acquires KEY SHARE on its referenced account. FOR UPDATE
  -- conflicts with that lock, including inserts from other application paths. Lock
  -- accounts in UUID order to avoid a cycle between simultaneous CSV imports.
  FOR v_account IN SELECT DISTINCT (r.value->>'account_id')::uuid
    FROM jsonb_array_elements(p_rows) AS r(value)
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.accounts
      WHERE id = v_account AND user_id = v_user AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501'; END IF;
  END LOOP;

  FOR v_row, v_index IN SELECT value, ordinality::integer - 1
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    IF (v_row->>'amount')::numeric <= 0 OR (v_row->>'date') IS NULL
      OR (v_row->>'account_id') IS NULL THEN
      RAISE EXCEPTION 'Invalid transaction row' USING ERRCODE = '22023';
    END IF;
    IF v_row->>'category_id' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.categories WHERE id = (v_row->>'category_id')::uuid AND user_id = v_user
    ) THEN RAISE EXCEPTION 'Category does not belong to caller' USING ERRCODE = '42501'; END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('index', v_index, 'match',
      jsonb_build_object('id', t.id, 'date', t.date, 'amount', t.amount,
        'description', t.description, 'account_id', t.account_id)) ORDER BY t.id), '[]'::jsonb)
      INTO v_matches FROM public.transactions AS t
      WHERE t.user_id = v_user AND t.deleted_at IS NULL
        AND t.account_id = (v_row->>'account_id')::uuid
        AND t.date = (v_row->>'date')::date
        AND t.amount = (v_row->>'amount')::numeric;
    -- Earlier rows in this request are also candidates. Their stable synthetic IDs
    -- let the caller review a repeated payment without silently discarding it.
    v_matches := v_matches || coalesce((
      SELECT jsonb_agg(jsonb_build_object('index', v_index, 'match',
        jsonb_build_object('id', 'batch:' || (r.ordinality - 1)::text,
          'date', r.value->>'date', 'amount', (r.value->>'amount')::numeric,
          'description', coalesce(r.value->>'description', ''),
          'account_id', r.value->>'account_id')) ORDER BY r.ordinality)
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, ordinality)
      WHERE r.ordinality - 1 < v_index
        AND r.value->>'date' = v_row->>'date'
        AND (r.value->>'amount')::numeric = (v_row->>'amount')::numeric
        AND r.value->>'account_id' = v_row->>'account_id'
    ), '[]'::jsonb);
    v_duplicates := v_duplicates || v_matches;
    SELECT value INTO v_review FROM jsonb_array_elements(p_reviews)
      WHERE (value->>'index')::integer = v_index;
    IF jsonb_array_length(v_matches) > 0 THEN
      IF v_review IS NULL THEN
        v_unreviewed := v_unreviewed || to_jsonb(v_index);
      ELSIF v_review->>'decision' NOT IN ('import', 'skip')
        OR jsonb_typeof(v_review->'match_ids') <> 'array'
        OR jsonb_array_length(v_review->'match_ids') <> jsonb_array_length(v_matches)
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_matches) AS m(value)
          WHERE NOT ((v_review->'match_ids') ? (m.value->'match'->>'id'))) THEN
        v_stale := v_stale || to_jsonb(v_index);
      END IF;
    END IF;
    v_review := NULL;
  END LOOP;
  IF jsonb_array_length(v_unreviewed) > 0 OR jsonb_array_length(v_stale) > 0 THEN
    RETURN jsonb_build_object('status', 'review_required', 'duplicates', v_duplicates,
      'unreviewed', v_unreviewed, 'stale', v_stale);
  END IF;

  INSERT INTO public.usage_tracking(user_id, month)
    VALUES(v_user, v_month) ON CONFLICT(user_id, month) DO NOTHING;
  SELECT transactions_count INTO v_used FROM public.usage_tracking
    WHERE user_id = v_user AND month = v_month FOR UPDATE;
  SELECT plan INTO v_plan FROM public.subscriptions WHERE user_id = v_user;
  IF coalesce(v_plan, 'free') = 'free' THEN
    SELECT coalesce((SELECT value::integer FROM public.app_settings
      WHERE key = 'free_transactions_limit'), 50) INTO v_limit;
    SELECT count(*) INTO v_imported FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, ordinality)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_reviews) AS rev(value)
        WHERE (rev.value->>'index')::integer = r.ordinality - 1
          AND rev.value->>'decision' = 'skip');
    IF coalesce(v_used, 0) + v_imported > v_limit THEN
      RAISE EXCEPTION 'Transaction limit exceeded' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_imported := 0;
  INSERT INTO public.imports(user_id, source, file_name, file_path, row_count,
    imported_count, skipped_count, status, request_id, request_hash)
  VALUES(v_user, 'csv', coalesce(p_file_name, 'import.csv'), NULL,
    coalesce(p_row_count, jsonb_array_length(p_rows)), 0, 0, 'pending', p_request_id, v_hash)
  RETURNING id INTO v_import_id;

  FOR v_row, v_index IN SELECT value, ordinality::integer - 1
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
  LOOP
    SELECT value INTO v_review FROM jsonb_array_elements(p_reviews)
      WHERE (value->>'index')::integer = v_index;
    IF v_review->>'decision' = 'skip' THEN
      v_skipped := v_skipped + 1;
    ELSE
      INSERT INTO public.transactions(user_id, import_id, date, time, amount, description,
        notes, type, payment_method, source, account_id, category_id, duplicate_status)
      VALUES(v_user, v_import_id, (v_row->>'date')::date,
        coalesce((v_row->>'time')::time, '12:00:00'::time), (v_row->>'amount')::numeric,
        coalesce(v_row->>'description', ''), v_row->>'notes',
        coalesce(v_row->>'type', 'expense'), v_row->>'payment_method',
        coalesce(v_row->>'source', 'csv_import'), (v_row->>'account_id')::uuid,
        (v_row->>'category_id')::uuid,
        CASE WHEN v_review->>'decision' = 'import' THEN 'confirmed' ELSE NULL END);
      -- Match applyTransactionBalance: CSV rows have no destination for transfers.
      IF coalesce(v_row->>'type', 'expense') IN ('expense', 'income') THEN
        UPDATE public.accounts SET balance = coalesce(balance, 0) +
          CASE WHEN coalesce(v_row->>'type', 'expense') = 'expense'
            THEN -(v_row->>'amount')::numeric ELSE (v_row->>'amount')::numeric END
          WHERE id = (v_row->>'account_id')::uuid AND user_id = v_user;
      END IF;
      v_imported := v_imported + 1;
    END IF;
    v_review := NULL;
  END LOOP;
  UPDATE public.usage_tracking SET transactions_count = transactions_count + v_imported,
    updated_at = now() WHERE user_id = v_user AND month = v_month;
  UPDATE public.imports SET status = 'completed', imported_count = v_imported,
    skipped_count = v_skipped WHERE id = v_import_id;
  RETURN jsonb_build_object('status', 'completed', 'imported', v_imported,
    'skipped', v_skipped, 'import_id', v_import_id, 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_csv_import(uuid, jsonb, jsonb, jsonb, text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_csv_import(uuid, jsonb, jsonb, jsonb, text, integer, boolean) TO authenticated;
