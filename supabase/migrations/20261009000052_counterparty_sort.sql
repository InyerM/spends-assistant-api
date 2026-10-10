-- Sort the complete owner catalog before applying pagination.
CREATE FUNCTION public.list_counterparties_sorted(p_query text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_sort text DEFAULT 'recent') RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH contacts AS (
  SELECT c.*,coalesce(c.custom_name,c.display_name) AS name,
    (SELECT count(*) FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id WHERE l.user_id=auth.uid() AND l.contact_id=c.id AND t.deleted_at IS NULL) AS movement_count,
    (SELECT max(t.date) FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id WHERE l.user_id=auth.uid() AND l.contact_id=c.id AND t.deleted_at IS NULL) AS last_activity
  FROM public.counterparties c WHERE c.user_id=auth.uid()
   AND position(lower(coalesce(p_query,'')) IN lower(coalesce(c.custom_name,c.display_name)||' '||c.identity_value))>0
 ), active AS (SELECT * FROM contacts WHERE movement_count>0), page AS (
  SELECT * FROM active ORDER BY CASE WHEN p_sort='most_transactions' THEN movement_count END DESC,CASE WHEN p_sort='fewest_transactions' THEN movement_count END ASC,last_activity DESC,name,id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),100)
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY CASE WHEN p_sort='most_transactions' THEN movement_count END DESC,CASE WHEN p_sort='fewest_transactions' THEN movement_count END ASC,last_activity DESC,name,id) FROM page),'[]'::jsonb),'count',(SELECT count(*) FROM active),'scan',jsonb_build_object(
  'total',(SELECT count(*) FROM public.transactions WHERE user_id=auth.uid() AND deleted_at IS NULL),
  'scanned',(SELECT count(*) FROM public.counterparty_scan_results s JOIN public.transactions t ON t.id=s.transaction_id AND t.user_id=s.user_id WHERE s.user_id=auth.uid() AND t.deleted_at IS NULL),
  'unresolved',(SELECT count(*) FROM public.counterparty_scan_results s JOIN public.transactions t ON t.id=s.transaction_id AND t.user_id=s.user_id WHERE s.user_id=auth.uid() AND t.deleted_at IS NULL AND s.status IN ('no_evidence','ambiguous'))
  ));
$$;
REVOKE ALL ON FUNCTION public.list_counterparties_sorted(text,integer,integer,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_counterparties_sorted(text,integer,integer,text) TO authenticated;

