-- Offer history cleanup after a reviewed category; never infer that a different category is wrong.
CREATE FUNCTION public.counterparty_category_followup(p_transaction uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); source public.transactions; contact public.counterparties; result jsonb;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO source FROM public.transactions WHERE id=p_transaction AND user_id=v_user AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
 IF source.category_id IS NULL OR source.type='transfer' THEN RETURN NULL; END IF;
 SELECT c.* INTO contact FROM public.counterparties c JOIN public.transaction_counterparties l ON l.contact_id=c.id AND l.user_id=c.user_id
 WHERE l.transaction_id=source.id AND l.user_id=v_user;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('contact_name',coalesce(contact.custom_name,contact.display_name),'category_id',source.category_id,
  'category_name',(SELECT name FROM public.categories WHERE id=source.category_id AND (user_id=v_user OR user_id IS NULL)),
  'rows',coalesce(jsonb_agg(to_jsonb(history)),'[]'::jsonb)) INTO result FROM (
  SELECT t.id,t.category_id,t.description,t.date,t.amount,t.currency,c.name AS category_name
  FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
  LEFT JOIN public.categories c ON c.id=t.category_id AND (c.user_id=v_user OR c.user_id IS NULL)
  WHERE l.contact_id=contact.id AND l.user_id=v_user AND t.deleted_at IS NULL AND t.type=source.type AND t.id<>source.id
    AND t.category_id IS DISTINCT FROM source.category_id
  ORDER BY t.date DESC,t.id LIMIT 100
 ) history;
 RETURN result;
END $$;

CREATE FUNCTION public.apply_counterparty_category_followup(p_transaction uuid,p_category uuid,p_targets jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); source public.transactions; v_contact uuid; v_row record; v_expected jsonb; v_count integer:=0;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF jsonb_typeof(p_targets) IS DISTINCT FROM 'array' OR jsonb_array_length(p_targets) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid category selection'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('category-followup:'||v_user::text,0));
 SELECT * INTO source FROM public.transactions WHERE id=p_transaction AND user_id=v_user AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
 IF source.category_id IS DISTINCT FROM p_category OR source.type='transfer' OR p_category IS NULL THEN RAISE EXCEPTION 'Reviewed category changed'; END IF;
 PERFORM 1 FROM public.categories WHERE id=p_category AND (user_id=v_user OR user_id IS NULL) AND is_active AND deleted_at IS NULL AND type=source.type FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Category not found'; END IF;
 SELECT contact_id INTO v_contact FROM public.transaction_counterparties WHERE transaction_id=p_transaction AND user_id=v_user FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found'; END IF;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_targets))<>jsonb_array_length(p_targets) THEN RAISE EXCEPTION 'Repeated category targets'; END IF;
 FOR v_row IN SELECT t.id,t.category_id FROM public.transactions t JOIN public.transaction_counterparties l ON l.transaction_id=t.id AND l.user_id=t.user_id
  WHERE l.contact_id=v_contact AND l.user_id=v_user AND t.deleted_at IS NULL AND t.type=source.type AND t.id<>source.id
    AND t.id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_targets)) ORDER BY t.id FOR UPDATE OF t
 LOOP
  SELECT value INTO v_expected FROM jsonb_array_elements(p_targets) WHERE value->>'id'=v_row.id::text;
  IF v_row.category_id IS DISTINCT FROM nullif(v_expected->>'category_id','')::uuid THEN RAISE EXCEPTION 'Historical category changed; refresh the suggestion'; END IF;
  v_count:=v_count+1;
 END LOOP;
 IF v_count<>jsonb_array_length(p_targets) THEN RAISE EXCEPTION 'Selected contact movements changed'; END IF;
 UPDATE public.transactions SET category_id=p_category WHERE user_id=v_user AND id IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_targets));
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.counterparty_category_followup(uuid),public.apply_counterparty_category_followup(uuid,uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.counterparty_category_followup(uuid),public.apply_counterparty_category_followup(uuid,uuid,jsonb) TO authenticated;
