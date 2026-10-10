-- Aggregate confirmed ledger history without mixing currencies or owners.
CREATE FUNCTION public.contact_insights() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE summary jsonb; spending jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authenticated owner required' USING ERRCODE='42501'; END IF;
 summary := public.list_counterparties_sorted('',0,5,'most_transactions');
 WITH totals AS (
  SELECT c.id,currency,sum(t.amount) AS amount,count(*) AS expense_count
  FROM public.transaction_counterparties l
  JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
  JOIN public.counterparties c ON c.id=l.contact_id AND c.user_id=l.user_id
  WHERE l.user_id=auth.uid() AND t.deleted_at IS NULL AND t.type='expense'
    AND t.transfer_id IS NULL AND t.transfer_to_account_id IS NULL AND t.currency IN ('COP','USD')
  GROUP BY c.id,currency
 ), ranked AS (
  SELECT totals.*,row_number() OVER(PARTITION BY currency ORDER BY amount DESC,id) AS rank FROM totals
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)||to_jsonb(r) ORDER BY r.currency,r.rank),'[]'::jsonb)
 INTO spending FROM ranked r JOIN public.counterparties c ON c.id=r.id AND c.user_id=auth.uid() WHERE rank<=5;
 RETURN summary||jsonb_build_object('spending',spending);
END $$;
REVOKE ALL ON FUNCTION public.contact_insights() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.contact_insights() TO authenticated;
