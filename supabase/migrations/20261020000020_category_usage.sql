-- Keep historical and configured categories in the usual collection without changing visibility.
CREATE FUNCTION public.category_usage_summary() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); result jsonb;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 WITH used AS (
  SELECT category_id FROM public.transactions WHERE user_id=owner
  UNION SELECT category_id FROM public.monthly_budgets WHERE user_id=owner
  UNION SELECT category_id FROM public.common_expenses WHERE user_id=owner
  UNION SELECT category_id FROM public.planned_expenses WHERE user_id=owner
  UNION SELECT c.id FROM public.categories c JOIN public.automation_rules r ON r.actions->>'set_category'=c.id::text WHERE c.user_id=owner AND r.user_id=owner
 )
 SELECT jsonb_build_object('used_ids',coalesce(jsonb_agg(c.id ORDER BY c.id),'[]'::jsonb)) INTO result
 FROM public.categories c JOIN used ON used.category_id=c.id WHERE c.user_id=owner AND c.deleted_at IS NULL;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.category_usage_summary() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.category_usage_summary() TO authenticated;
