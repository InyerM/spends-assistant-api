-- Offer history cleanup after a reviewed category; never infer that a different category is wrong.
CREATE OR REPLACE FUNCTION public.counterparty_category_followup(p_transaction uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); source public.transactions; contact public.counterparties; result jsonb;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO source FROM public.transactions WHERE id=p_transaction AND user_id=v_user AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
 IF source.category_id IS NULL OR source.type='transfer' OR EXISTS(SELECT 1 FROM public.categories WHERE id=source.category_id AND slug IN ('uncategorized','uncategorized-income')) THEN RETURN NULL; END IF;
 SELECT c.* INTO contact FROM public.counterparties c JOIN public.transaction_counterparties l ON l.contact_id=c.id AND l.user_id=c.user_id
 WHERE l.transaction_id=source.id AND l.user_id=v_user;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('contact_name',coalesce(contact.custom_name,contact.display_name),'category_id',source.category_id,
  'category_name',(SELECT name FROM public.categories WHERE id=source.category_id AND (user_id=v_user OR user_id IS NULL)),
  'source',jsonb_build_object('id',source.id,'type',source.type,'description',source.description,'notes',source.notes,'excerpt',left(source.raw_text,2000)),
  'evidence',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM (SELECT t.id,t.description,t.notes,t.category_id,c.name AS category_name FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id JOIN public.categories c ON c.id=t.category_id AND (c.user_id=v_user OR c.user_id IS NULL) WHERE l.user_id=v_user AND l.contact_id=contact.id AND t.type=source.type AND t.deleted_at IS NULL AND c.slug NOT IN ('uncategorized','uncategorized-income') ORDER BY t.date DESC,t.id LIMIT 8) e),'[]'::jsonb),
  'rows',coalesce(jsonb_agg(to_jsonb(history)),'[]'::jsonb)) INTO result FROM (
  SELECT t.id,t.category_id,t.description,t.notes,t.date,t.amount,t.currency,c.name AS category_name,(t.category_id IS NULL OR c.slug IN ('uncategorized','uncategorized-income')) AS is_uncategorized
  FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
  LEFT JOIN public.categories c ON c.id=t.category_id AND (c.user_id=v_user OR c.user_id IS NULL)
  WHERE l.contact_id=contact.id AND l.user_id=v_user AND t.deleted_at IS NULL AND t.type=source.type AND t.id<>source.id
    AND t.category_id IS DISTINCT FROM source.category_id
  ORDER BY t.date DESC,t.id LIMIT 100
 ) history;
 RETURN result;
END $$;


CREATE FUNCTION public.apply_counterparty_review(p_source uuid,p_source_category uuid,p_targets jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); source public.transactions; v_contact uuid; item jsonb; target public.transactions; v_count integer:=0;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_targets) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid review selection'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('category-followup:'||v_user::text,0));
 SELECT * INTO source FROM public.transactions WHERE id=p_source AND user_id=v_user AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR source.category_id IS DISTINCT FROM p_source_category OR source.type='transfer' THEN RAISE EXCEPTION 'Reviewed source changed'; END IF;
 SELECT contact_id INTO v_contact FROM public.transaction_counterparties WHERE user_id=v_user AND transaction_id=source.id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found'; END IF;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_targets))<>jsonb_array_length(p_targets) THEN RAISE EXCEPTION 'Repeated targets'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_targets) ORDER BY value->>'id' LOOP
  SELECT t.* INTO target FROM public.transactions t JOIN public.transaction_counterparties l ON l.transaction_id=t.id AND l.user_id=t.user_id
   WHERE t.id=(item->>'id')::uuid AND t.id<>source.id AND t.user_id=v_user AND l.contact_id=v_contact AND t.type=source.type AND t.deleted_at IS NULL FOR UPDATE OF t;
  IF NOT FOUND OR target.category_id IS DISTINCT FROM nullif(item->>'expected_category_id','')::uuid OR target.description IS DISTINCT FROM item->>'expected_description' OR target.notes IS DISTINCT FROM item->>'expected_notes' THEN RAISE EXCEPTION 'Movement changed; refresh before reviewing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.categories WHERE id=(item->>'category_id')::uuid AND (user_id=v_user OR user_id IS NULL) AND type=source.type AND is_active AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Category not found'; END IF;
  IF (item->>'description' IS DISTINCT FROM target.description AND length(btrim(coalesce(item->>'description',''))) NOT BETWEEN 1 AND 500) OR (item->>'notes' IS DISTINCT FROM target.notes AND length(coalesce(item->>'notes',''))>1500) THEN RAISE EXCEPTION 'Invalid reviewed text'; END IF;
  UPDATE public.transactions SET category_id=(item->>'category_id')::uuid,description=btrim(item->>'description'),notes=item->>'notes' WHERE id=target.id AND user_id=v_user;
  v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.counterparty_category_followup(uuid),public.apply_counterparty_review(uuid,uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.counterparty_category_followup(uuid),public.apply_counterparty_review(uuid,uuid,jsonb) TO authenticated;
