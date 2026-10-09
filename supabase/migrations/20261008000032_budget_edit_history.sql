-- Editing a limit is an owner-authorized, atomic transition with retained evidence.
CREATE TABLE public.monthly_budget_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES public.monthly_budgets(id),
  effective_month date NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.monthly_budget_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_budget_edits_owner_read ON public.monthly_budget_edits
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY terms_acceptance_required ON public.monthly_budget_edits
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.has_accepted_required_terms()))
  WITH CHECK ((SELECT public.has_accepted_required_terms()));
REVOKE ALL ON public.monthly_budget_edits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.monthly_budget_edits TO authenticated;
GRANT ALL ON public.monthly_budget_edits TO service_role;

-- A one-month category reassignment leaves the original recurring rule intact afterward.
CREATE TABLE public.monthly_budget_skips (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES public.monthly_budgets(id),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  PRIMARY KEY (budget_id, month)
);
ALTER TABLE public.monthly_budget_skips ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_budget_skips_owner_read ON public.monthly_budget_skips
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY terms_acceptance_required ON public.monthly_budget_skips
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.has_accepted_required_terms()))
  WITH CHECK ((SELECT public.has_accepted_required_terms()));
REVOKE ALL ON public.monthly_budget_skips FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.monthly_budget_skips TO authenticated;
GRANT ALL ON public.monthly_budget_skips TO service_role;

CREATE FUNCTION public.update_monthly_budget(
  p_budget_id uuid, p_month date, p_category_id uuid, p_limit_cop numeric,
  p_repeat_monthly boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_before public.monthly_budgets;
  v_after public.monthly_budgets;
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Budget month must be its first day' USING ERRCODE = '22023';
  END IF;
  -- The table lock prevents legacy upserts racing into a silent category collision.
  LOCK TABLE public.monthly_budgets IN SHARE ROW EXCLUSIVE MODE;
  -- Serializing per owner also protects concurrent category/month edits.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  SELECT * INTO v_before FROM public.monthly_budgets
    WHERE id = p_budget_id AND user_id = v_user AND is_active
      AND (month = p_month OR (repeat_monthly AND month <= p_month))
      AND (ends_before IS NULL OR p_month < ends_before)
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.monthly_budgets
    WHERE user_id = v_user AND category_id = p_category_id AND month = p_month
      AND id <> p_budget_id) OR EXISTS (
    SELECT 1 FROM public.get_monthly_budget_status(p_month) AS s
      WHERE s.category_id = p_category_id AND s.budget_id <> p_budget_id
  ) THEN
    RAISE EXCEPTION 'A budget already exists for this category and month' USING ERRCODE = '23505';
  END IF;
  IF p_category_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.categories AS c WHERE c.id = p_category_id AND c.user_id = v_user
      AND c.type = 'expense' AND c.is_active AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Owned active expense category required' USING ERRCODE = '42501';
  END IF;
  IF v_before.month = p_month THEN
    -- Validation in upsert runs in the same transaction; any failure rolls this back.
    UPDATE public.monthly_budgets SET category_id = p_category_id
      WHERE id = p_budget_id AND user_id = v_user;
  ELSIF p_repeat_monthly THEN
    PERFORM public.stop_monthly_budget(p_budget_id, p_month);
  ELSIF v_before.category_id <> p_category_id THEN
    INSERT INTO public.monthly_budget_skips(user_id, budget_id, month)
      VALUES(v_user, p_budget_id, p_month) ON CONFLICT DO NOTHING;
  END IF;
  v_id := public.upsert_monthly_budget(p_month, p_category_id, p_limit_cop, p_repeat_monthly);
  -- A replacement never extends beyond the original rule's recorded end.
  IF p_repeat_monthly AND v_before.ends_before IS NOT NULL THEN
    UPDATE public.monthly_budgets
      SET ends_before = least(coalesce(ends_before, v_before.ends_before), v_before.ends_before)
      WHERE id = v_id;
  END IF;
  SELECT * INTO v_after FROM public.monthly_budgets WHERE id = v_id;
  INSERT INTO public.monthly_budget_edits(user_id, budget_id, effective_month, before_state, after_state)
    VALUES(v_user, v_id, p_month, to_jsonb(v_before), to_jsonb(v_after));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.update_monthly_budget(uuid, date, uuid, numeric, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_monthly_budget(uuid, date, uuid, numeric, boolean)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_monthly_budget_status(p_month date)
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
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
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
      AND NOT EXISTS (SELECT 1 FROM public.monthly_budget_skips AS skip
        WHERE skip.user_id = v_user AND skip.budget_id = b.id AND skip.month = p_month)
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

-- Creation must never overwrite a different budget through an upsert conflict.
CREATE FUNCTION public.create_monthly_budget(
  p_month date, p_category_id uuid, p_limit_cop numeric, p_repeat_monthly boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  LOCK TABLE public.monthly_budgets IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.monthly_budgets
      WHERE user_id = v_user AND month = p_month AND category_id = p_category_id AND is_active)
    OR EXISTS (SELECT 1 FROM public.get_monthly_budget_status(p_month)
      WHERE category_id = p_category_id) THEN
    RAISE EXCEPTION 'A budget already exists for this category and month' USING ERRCODE = '23505';
  END IF;
  RETURN public.upsert_monthly_budget(p_month, p_category_id, p_limit_cop, p_repeat_monthly);
END;
$$;
REVOKE ALL ON FUNCTION public.create_monthly_budget(date, uuid, numeric, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_monthly_budget(date, uuid, numeric, boolean)
  TO authenticated;
