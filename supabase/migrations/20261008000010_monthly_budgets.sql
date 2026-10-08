-- Monthly COP limits are informational; posting never waits for or changes a budget.
ALTER TABLE public.categories
  ADD CONSTRAINT categories_id_user_unique UNIQUE (id, user_id);

CREATE TABLE public.monthly_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  category_id uuid NOT NULL,
  limit_cop numeric(15,2) NOT NULL CHECK (limit_cop > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (category_id, user_id) REFERENCES public.categories(id, user_id),
  UNIQUE (user_id, month, category_id)
);
CREATE INDEX monthly_budgets_owner_month_idx
  ON public.monthly_budgets(user_id, month) WHERE is_active;
CREATE INDEX transactions_budget_actuals_idx
  ON public.transactions(user_id, date, category_id)
  INCLUDE (amount, currency, duplicate_status)
  WHERE deleted_at IS NULL AND type = 'expense';
CREATE INDEX categories_budget_tree_idx
  ON public.categories(user_id, parent_id) WHERE deleted_at IS NULL;

ALTER TABLE public.monthly_budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_budgets_owner_read ON public.monthly_budgets
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.monthly_budgets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.monthly_budgets TO authenticated;
GRANT ALL ON public.monthly_budgets TO service_role;

CREATE FUNCTION public.upsert_monthly_budget(
  p_month date, p_category_id uuid, p_limit_cop numeric
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Budget month must be its first day' USING ERRCODE = '22023';
  END IF;
  IF p_limit_cop IS NULL OR p_limit_cop <= 0 OR p_limit_cop > 9999999999999.99
    OR p_limit_cop <> round(p_limit_cop, 2) THEN
    RAISE EXCEPTION 'Invalid COP budget limit' USING ERRCODE = '22023';
  END IF;
  IF p_category_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.categories AS c
    WHERE c.id = p_category_id AND c.user_id = v_user
      AND c.type = 'expense' AND c.is_active AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Owned active expense category required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT c.id, c.parent_id, c.slug FROM public.categories AS c
      WHERE c.id = p_category_id AND c.user_id = v_user
      UNION
      SELECT c.id, c.parent_id, c.slug FROM public.categories AS c
      JOIN ancestors AS a ON a.parent_id = c.id
      WHERE c.user_id = v_user
    )
    SELECT 1 FROM ancestors WHERE slug IN ('investments', 'loans')
  ) THEN
    RAISE EXCEPTION 'Principal and investment categories cannot have spending budgets'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.monthly_budgets(user_id, month, category_id, limit_cop)
    VALUES(v_user, p_month, p_category_id, p_limit_cop)
    ON CONFLICT (user_id, month, category_id) DO UPDATE
      SET limit_cop = EXCLUDED.limit_cop, is_active = true, updated_at = now()
    RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_monthly_budget(date, uuid, numeric)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_monthly_budget(date, uuid, numeric)
  TO authenticated;

CREATE FUNCTION public.deactivate_monthly_budget(p_budget_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_changed boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  UPDATE public.monthly_budgets
    SET is_active = false, updated_at = now()
    WHERE id = p_budget_id AND user_id = v_user AND is_active;
  v_changed := FOUND;
  RETURN v_changed;
END;
$$;
REVOKE ALL ON FUNCTION public.deactivate_monthly_budget(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_monthly_budget(uuid) TO authenticated;

CREATE FUNCTION public.get_monthly_budget_status(p_month date)
RETURNS TABLE (
  budget_id uuid,
  category_id uuid,
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
    SELECT b.id, b.category_id, b.limit_cop FROM public.monthly_budgets AS b
    WHERE b.user_id = v_user AND b.month = p_month AND b.is_active
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
    SELECT b.id, b.category_id, b.limit_cop,
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
    GROUP BY b.id, b.category_id, b.limit_cop
  )
  SELECT totals.id, totals.category_id, totals.limit_cop, totals.spent,
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
