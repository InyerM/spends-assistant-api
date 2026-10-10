-- Keep shared category labels visible in the owner-scoped contact history.
CREATE OR REPLACE FUNCTION public.counterparty_detail(p_contact uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH movements AS (
  SELECT t.* FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
  WHERE l.user_id=auth.uid() AND l.contact_id=p_contact AND t.deleted_at IS NULL
 ), currencies AS (
  SELECT currency,count(*) AS count,sum(amount) FILTER(WHERE type='expense') AS expenses,sum(amount) FILTER(WHERE type='income') AS income FROM movements GROUP BY currency
 ), categories AS (SELECT m.category_id,c.name,c.translations,count(*) AS count FROM movements m LEFT JOIN public.categories c ON c.id=m.category_id AND (c.user_id=auth.uid() OR c.user_id IS NULL) GROUP BY m.category_id,c.name,c.translations), recent AS (
  SELECT id,date,description,amount,currency,type,category_id FROM movements ORDER BY date DESC,id LIMIT 100
 ) SELECT jsonb_build_object('contact',to_jsonb(c),'totals',coalesce((SELECT jsonb_agg(to_jsonb(currencies)) FROM currencies),'[]'::jsonb),'categories',coalesce((SELECT jsonb_agg(to_jsonb(categories)) FROM categories),'[]'::jsonb),'transactions',coalesce((SELECT jsonb_agg(to_jsonb(recent)) FROM recent),'[]'::jsonb),'movement_count',(SELECT count(*) FROM movements))
 FROM public.counterparties c WHERE c.id=p_contact AND c.user_id=auth.uid();
$$;
