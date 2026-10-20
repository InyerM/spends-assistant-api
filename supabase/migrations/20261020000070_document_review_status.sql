-- Workflow labels organize reviewed captures independently of extraction and financial evidence.
ALTER TABLE public.documents ADD COLUMN review_status text NOT NULL DEFAULT 'active' CHECK(review_status IN ('active','completed','no_movements'));
CREATE TABLE public.document_review_status_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 document_id uuid NOT NULL,before_status text NOT NULL,after_status text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(document_id,user_id) REFERENCES public.documents(id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.document_review_status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_review_status_owner ON public.document_review_status_events FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()));
REVOKE ALL ON public.document_review_status_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.document_review_status_events TO authenticated;
CREATE TRIGGER document_review_status_events_immutable BEFORE UPDATE OR DELETE ON public.document_review_status_events FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();
CREATE FUNCTION public.guard_document_review_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('uploaded','processing','failed') THEN
  IF OLD.review_status<>'active' THEN
   NEW.review_status:='active';
   INSERT INTO public.document_review_status_events(user_id,document_id,before_status,after_status) VALUES(NEW.user_id,NEW.id,OLD.review_status,'active');
  END IF;
 ELSIF NEW.review_status IS DISTINCT FROM OLD.review_status AND current_setting('app.document_review_status',true) IS DISTINCT FROM NEW.id::text THEN
  RAISE EXCEPTION 'Document workflow changes require an audited decision';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_review_status_guard BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.guard_document_review_status();
CREATE FUNCTION public.set_document_review_status(p_document uuid,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); target public.documents; previous text:=current_setting('app.document_review_status',true);
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF p_status IS NULL OR p_status NOT IN ('active','completed','no_movements') THEN RAISE EXCEPTION 'Invalid workflow status'; END IF;
 SELECT * INTO target FROM public.documents WHERE id=p_document AND user_id=owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
 IF p_status<>'active' AND target.status<>'extracted' THEN RAISE EXCEPTION 'Extract and review the document first'; END IF;
 IF p_status='no_movements' AND (EXISTS(SELECT 1 FROM public.document_observations WHERE document_id=p_document AND user_id=owner AND (status IN ('created','reconciled') OR match_transaction_id IS NOT NULL)) OR EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs WHERE document_id=p_document AND valid)) THEN RAISE EXCEPTION 'Document has linked movements'; END IF;
 IF target.review_status=p_status THEN RETURN; END IF;
 PERFORM set_config('app.document_review_status',p_document::text,true);
 UPDATE public.documents SET review_status=p_status WHERE id=p_document AND user_id=owner;
 PERFORM set_config('app.document_review_status',coalesce(previous,''),true);
 INSERT INTO public.document_review_status_events(user_id,document_id,before_status,after_status) VALUES(owner,p_document,target.review_status,p_status);
END $$;
REVOKE ALL ON FUNCTION public.set_document_review_status(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.set_document_review_status(uuid,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.pending_document_count()
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT count(*) FROM public.documents d
 WHERE d.user_id=(SELECT auth.uid()) AND d.archived_at IS NULL AND d.review_status='active'
 AND (d.status IN ('uploaded','processing','failed') OR EXISTS (
  SELECT 1 FROM public.document_observations o WHERE o.document_id=d.id AND o.user_id=d.user_id AND o.status='pending'
  AND NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs p WHERE p.observation_id=o.id AND p.valid)
 ) OR (d.document_type='statement' AND NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_scopes s WHERE s.document_id=d.id AND s.user_id=d.user_id)))
$$;
