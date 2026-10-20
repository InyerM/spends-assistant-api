-- Duplicate review changes metadata only; the linked posting remains evidence of the original flag.
CREATE FUNCTION public.confirm_transaction_not_duplicate(p_transaction uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); target public.transactions;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO target FROM public.transactions WHERE id=p_transaction AND user_id=owner AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='P0002'; END IF;
 IF target.duplicate_status='confirmed' THEN RETURN; END IF;
 IF target.duplicate_status IS DISTINCT FROM 'pending_review' THEN RAISE EXCEPTION 'Duplicate review changed' USING ERRCODE='23514'; END IF;
 UPDATE public.transactions SET duplicate_status='confirmed' WHERE id=target.id AND user_id=owner;
 INSERT INTO public.transaction_review_metadata_edits(user_id,transaction_id,before_state,after_state)
 VALUES(owner,target.id,jsonb_build_object('duplicate_status',target.duplicate_status,'duplicate_of',target.duplicate_of),jsonb_build_object('duplicate_status','confirmed','duplicate_of',target.duplicate_of));
END $$;
REVOKE ALL ON FUNCTION public.confirm_transaction_not_duplicate(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_transaction_not_duplicate(uuid) TO authenticated;
