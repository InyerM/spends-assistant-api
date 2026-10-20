-- Review expense categories independently of contact history, without changing financial evidence.
CREATE FUNCTION public.review_expense_category(p_transaction uuid,p_category uuid,p_expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); target public.transactions;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
   OR NOT (p_expected ?& ARRAY['category_id','description','notes','account_id'])
   OR (p_expected - ARRAY['category_id','description','notes','account_id']) <> '{}'::jsonb
 THEN RAISE EXCEPTION 'Invalid review context' USING ERRCODE='22023'; END IF;
 SELECT * INTO target FROM public.transactions WHERE id=p_transaction AND user_id=owner AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='P0002'; END IF;
 IF target.type <> 'expense'
   OR target.category_id IS DISTINCT FROM nullif(p_expected->>'category_id','')::uuid
   OR target.description IS DISTINCT FROM p_expected->>'description'
   OR target.notes IS DISTINCT FROM p_expected->>'notes'
   OR target.account_id IS DISTINCT FROM (p_expected->>'account_id')::uuid
 THEN RAISE EXCEPTION 'Movement changed; analyze again before applying' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.categories WHERE id=p_category AND user_id=owner AND type='expense' AND is_active AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='23514'; END IF;
 IF target.category_id IS NOT DISTINCT FROM p_category THEN RETURN; END IF;
 UPDATE public.transactions SET category_id=p_category,updated_at=now() WHERE id=target.id AND user_id=owner;
 INSERT INTO public.transaction_review_metadata_edits(user_id,transaction_id,before_state,after_state)
 VALUES(owner,target.id,
   jsonb_build_object('category_id',target.category_id,'description',target.description,'notes',target.notes),
   jsonb_build_object('category_id',p_category,'description',target.description,'notes',target.notes));
END $$;
REVOKE ALL ON FUNCTION public.review_expense_category(uuid,uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.review_expense_category(uuid,uuid,jsonb) TO authenticated;
