-- Apply only explicitly reviewed expense metadata; financial facts and evidence remain unchanged.
CREATE FUNCTION public.review_expense_metadata(p_transaction uuid,p_changes jsonb,p_expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); target public.transactions; revised public.transactions;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
   OR NOT (p_expected ?& ARRAY['category_id','description','notes','account_id'])
   OR (p_expected - ARRAY['category_id','description','notes','account_id']) <> '{}'::jsonb
 THEN RAISE EXCEPTION 'Invalid review context' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR p_changes='{}'::jsonb
   OR (p_changes - ARRAY['category_id','description','notes']) <> '{}'::jsonb
 THEN RAISE EXCEPTION 'Invalid review changes' USING ERRCODE='22023'; END IF;
 IF p_changes ? 'description' AND (jsonb_typeof(p_changes->'description') IS DISTINCT FROM 'string' OR length(btrim(p_changes->>'description')) NOT BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'Invalid review description' USING ERRCODE='22023'; END IF;
 IF p_changes ? 'notes' AND (jsonb_typeof(p_changes->'notes') NOT IN ('string','null') OR length(p_changes->>'notes')>1500)
 THEN RAISE EXCEPTION 'Invalid review notes' USING ERRCODE='22023'; END IF;
 IF p_changes ? 'category_id' AND (jsonb_typeof(p_changes->'category_id') IS DISTINCT FROM 'string' OR (p_changes->>'category_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 THEN RAISE EXCEPTION 'Invalid review category' USING ERRCODE='22023'; END IF;
 SELECT * INTO target FROM public.transactions WHERE id=p_transaction AND user_id=owner AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='P0002'; END IF;
 IF target.type <> 'expense'
   OR target.category_id IS DISTINCT FROM nullif(p_expected->>'category_id','')::uuid
   OR target.description IS DISTINCT FROM p_expected->>'description'
   OR target.notes IS DISTINCT FROM p_expected->>'notes'
   OR target.account_id IS DISTINCT FROM (p_expected->>'account_id')::uuid
 THEN RAISE EXCEPTION 'Movement changed; analyze again before applying' USING ERRCODE='23514'; END IF;
 revised:=target;
 IF p_changes ? 'category_id' THEN
  IF NOT EXISTS(SELECT 1 FROM public.categories WHERE id=(p_changes->>'category_id')::uuid AND user_id=owner AND type='expense' AND is_active AND deleted_at IS NULL)
  THEN RAISE EXCEPTION 'Category not found' USING ERRCODE='23514'; END IF;
  revised.category_id:=(p_changes->>'category_id')::uuid;
 END IF;
 IF p_changes ? 'description' THEN revised.description:=btrim(p_changes->>'description'); END IF;
 IF p_changes ? 'notes' THEN revised.notes:=p_changes->>'notes'; END IF;
 IF (target.category_id,target.description,target.notes) IS NOT DISTINCT FROM (revised.category_id,revised.description,revised.notes) THEN RETURN; END IF;
 UPDATE public.transactions SET category_id=revised.category_id,description=revised.description,notes=revised.notes,updated_at=now() WHERE id=target.id AND user_id=owner;
 INSERT INTO public.transaction_review_metadata_edits(user_id,transaction_id,before_state,after_state)
 VALUES(owner,target.id,
   jsonb_build_object('category_id',target.category_id,'description',target.description,'notes',target.notes),
   jsonb_build_object('category_id',revised.category_id,'description',revised.description,'notes',revised.notes));
END $$;
REVOKE ALL ON FUNCTION public.review_expense_metadata(uuid,jsonb,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.review_expense_metadata(uuid,jsonb,jsonb) TO authenticated;
