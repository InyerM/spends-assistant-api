-- A recurring limit is a dated rule. Each month has independent spending totals.
ALTER TABLE public.monthly_budgets
  ADD COLUMN repeat_monthly boolean NOT NULL DEFAULT false,
  ADD COLUMN ends_before date CHECK (ends_before > month AND ends_before = date_trunc('month', ends_before)::date);

CREATE FUNCTION public.upsert_monthly_budget(
  p_month date, p_category_id uuid, p_limit_cop numeric, p_repeat_monthly boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid;
BEGIN
  IF p_repeat_monthly IS NULL THEN
    RAISE EXCEPTION 'Budget recurrence is required' USING ERRCODE = '22023';
  END IF;
  -- Reuse the existing owner, category, principal exclusion and amount validation.
  v_id := public.upsert_monthly_budget(p_month, p_category_id, p_limit_cop);
  UPDATE public.monthly_budgets SET repeat_monthly = p_repeat_monthly,
      ends_before = CASE WHEN p_repeat_monthly THEN (
        SELECT min(later.month) FROM public.monthly_budgets AS later
        WHERE later.user_id = auth.uid() AND later.category_id = p_category_id
          AND later.month > p_month AND later.repeat_monthly AND later.is_active
      ) ELSE NULL END
    WHERE id = v_id AND user_id = auth.uid();
  IF p_repeat_monthly THEN
    UPDATE public.monthly_budgets SET ends_before = p_month, updated_at = now()
      WHERE user_id = auth.uid() AND category_id = p_category_id AND repeat_monthly
        AND month < p_month AND is_active AND (ends_before IS NULL OR ends_before > p_month);
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_monthly_budget(date, uuid, numeric, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_monthly_budget(date, uuid, numeric, boolean) TO authenticated;

CREATE FUNCTION public.stop_monthly_budget(p_budget_id uuid, p_month date)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid(); v_changed boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Budget month must be its first day' USING ERRCODE = '22023';
  END IF;
  UPDATE public.monthly_budgets
    SET ends_before = CASE WHEN repeat_monthly AND p_month > month THEN p_month ELSE ends_before END,
        is_active = CASE WHEN repeat_monthly AND p_month > month THEN true ELSE false END,
        updated_at = now()
    WHERE id = p_budget_id AND user_id = v_user AND is_active AND month <= p_month
      AND (repeat_monthly OR month = p_month)
      AND (ends_before IS NULL OR p_month < ends_before);
  v_changed := FOUND;
  RETURN v_changed;
END;
$$;
REVOKE ALL ON FUNCTION public.stop_monthly_budget(uuid, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.stop_monthly_budget(uuid, date) TO authenticated;

DROP FUNCTION public.get_monthly_budget_status(date);
CREATE FUNCTION public.get_monthly_budget_status(p_month date)
RETURNS TABLE (
  budget_id uuid,
  category_id uuid,
  repeat_monthly boolean,
  start_month date,
  limit_cop numeric,
  spent_cop numeric,
  pending_count integer,
  unknown_currency_count integer,
  excluded_count integer,
  threshold text,
  contributing_transactions jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Budget month must be its first day' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH RECURSIVE owned_budgets AS (
    SELECT DISTINCT ON (b.category_id) b.id, b.category_id, b.limit_cop,
      b.repeat_monthly, b.month AS start_month
    FROM public.monthly_budgets AS b
    WHERE b.user_id = v_user AND b.is_active
      AND (b.month = p_month OR (b.repeat_monthly AND b.month <= p_month))
      AND (b.ends_before IS NULL OR p_month < b.ends_before)
    ORDER BY b.category_id, b.month DESC
  ), category_tree AS (
    SELECT b.id AS budget_id, c.id AS member_id,
      c.slug IN ('investments', 'loans') AS principal_category
    FROM owned_budgets AS b
    JOIN public.categories AS c ON c.id = b.category_id AND c.user_id = v_user
    UNION
    SELECT tree.budget_id, child.id,
      tree.principal_category OR child.slug IN ('investments', 'loans')
    FROM category_tree AS tree
    JOIN public.categories AS child ON child.parent_id = tree.member_id
      AND child.user_id = v_user
  ), classified AS (
    SELECT tree.budget_id, t.id AS transaction_id, t.date, t.description,
      t.category_id, t.amount,
      coalesce(t.duplicate_status = 'pending_review', false) AS pending,
      t.currency IS DISTINCT FROM 'COP' AS unknown_currency,
      tree.principal_category
        OR EXISTS (SELECT 1 FROM public.investment_trades AS i
          WHERE i.user_id = v_user AND i.source_transaction_id = t.id)
        OR EXISTS (SELECT 1 FROM public.personal_receivable_events AS r
          WHERE r.user_id = v_user AND r.source_transaction_id = t.id)
        OR EXISTS (SELECT 1 FROM public.manual_loan_events AS l
          WHERE l.user_id = v_user AND l.source_transaction_id = t.id)
        OR EXISTS (SELECT 1 FROM public.relief_fund_entries AS f
          WHERE f.user_id = v_user AND f.transaction_id = t.id AND f.kind = 'outlay')
        AS excluded
    FROM category_tree AS tree
    JOIN public.transactions AS t ON t.user_id = v_user AND t.category_id = tree.member_id
      AND t.date >= p_month AND t.date < (p_month + interval '1 month')::date
      AND t.type = 'expense' AND t.deleted_at IS NULL
  ), totals AS (
    SELECT b.id, b.category_id, b.limit_cop, b.repeat_monthly, b.start_month,
      coalesce(sum(c.amount) FILTER (WHERE NOT c.pending AND NOT c.unknown_currency
        AND NOT c.excluded), 0)::numeric(15,2) AS spent,
      count(*) FILTER (WHERE c.pending)::integer AS pending_rows,
      count(*) FILTER (WHERE c.unknown_currency)::integer AS unknown_rows,
      count(*) FILTER (WHERE c.excluded)::integer AS excluded_rows,
      coalesce(jsonb_agg(jsonb_build_object(
        'id', c.transaction_id, 'date', c.date, 'description', c.description,
        'category_id', c.category_id, 'amount', c.amount
      ) ORDER BY c.date DESC, c.transaction_id)
        FILTER (WHERE NOT c.pending AND NOT c.unknown_currency AND NOT c.excluded),
        '[]'::jsonb) AS contributing_transactions
    FROM owned_budgets AS b
    LEFT JOIN classified AS c ON c.budget_id = b.id
    GROUP BY b.id, b.category_id, b.limit_cop, b.repeat_monthly, b.start_month
  )
  SELECT totals.id, totals.category_id, totals.repeat_monthly, totals.start_month, totals.limit_cop, totals.spent,
    totals.pending_rows, totals.unknown_rows, totals.excluded_rows,
    CASE WHEN totals.spent >= totals.limit_cop THEN '100'
      WHEN totals.spent >= totals.limit_cop * 0.8 THEN '80'
      ELSE 'none' END,
    totals.contributing_transactions
  FROM totals ORDER BY totals.id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_monthly_budget_status(date)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_monthly_budget_status(date) TO authenticated;
