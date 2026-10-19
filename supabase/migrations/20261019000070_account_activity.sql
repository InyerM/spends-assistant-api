-- Aggregate the complete ledger for a bounded period; never add different currencies.
CREATE FUNCTION public.account_activity(p_account uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=p_account AND user_id=auth.uid() AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Account not found'; END IF;
 WITH movements AS (
  SELECT t.* FROM public.transactions t WHERE t.user_id=auth.uid() AND t.account_id=p_account AND t.deleted_at IS NULL
   AND t.date>=date_trunc('month',current_date)-interval '5 months' AND t.date<=current_date
 ), months AS (
  SELECT to_char(m,'YYYY-MM') AS month,coalesce(sum(t.amount) FILTER(WHERE t.type='income'),0) AS income,
   coalesce(sum(t.amount) FILTER(WHERE t.type='expense'),0) AS expenses,count(t.id) AS count
  FROM generate_series(date_trunc('month',current_date)-interval '5 months',date_trunc('month',current_date),interval '1 month') m
  LEFT JOIN movements t ON date_trunc('month',t.date)=m GROUP BY m ORDER BY m
 ), categories AS (
  SELECT t.category_id,c.name,c.translations,sum(t.amount) AS amount FROM movements t
  LEFT JOIN public.categories c ON c.id=t.category_id AND (c.user_id=auth.uid() OR c.user_id IS NULL)
  WHERE t.type='expense' GROUP BY t.category_id,c.name,c.translations ORDER BY amount DESC LIMIT 5
 ) SELECT jsonb_build_object('months',(SELECT jsonb_agg(to_jsonb(months)) FROM months),
  'categories',coalesce((SELECT jsonb_agg(to_jsonb(categories)) FROM categories),'[]'::jsonb),
  'count',(SELECT count(*) FROM movements),'income',coalesce((SELECT sum(amount) FROM movements WHERE type='income'),0),
  'expenses',coalesce((SELECT sum(amount) FROM movements WHERE type='expense'),0),
  'period_start',to_char(date_trunc('month',current_date)-interval '5 months','YYYY-MM-DD'),'period_end',current_date) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.account_activity(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.account_activity(uuid) TO authenticated;
