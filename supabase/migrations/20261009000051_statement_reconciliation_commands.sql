-- Durable replay keys for queued mobile commands, including retries after undo.
CREATE TABLE public.statement_reconciliation_commands (
  request_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);
ALTER TABLE public.statement_reconciliation_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY statement_command_owner ON public.statement_reconciliation_commands FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
REVOKE ALL ON public.statement_reconciliation_commands FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.statement_reconciliation_commands TO authenticated;
CREATE TRIGGER statement_command_immutable BEFORE UPDATE OR DELETE ON public.statement_reconciliation_commands FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();
CREATE FUNCTION public.apply_statement_reconciliation_command(p_request_id uuid,p_document_id uuid,p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); v_existing public.statement_reconciliation_commands; v_action text:=p_payload->>'action';
BEGIN
 IF v_user IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'Authentication and request key required'; END IF;
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 SELECT * INTO v_existing FROM public.statement_reconciliation_commands WHERE user_id=v_user AND request_id=p_request_id;
 IF FOUND THEN
   IF v_existing.document_id IS DISTINCT FROM p_document_id OR v_existing.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'Request key was already used'; END IF;
   RETURN;
 END IF;
 IF jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Invalid reconciliation command'; END IF;
 IF v_action='scope' AND (p_payload-ARRAY['action','account_id','period_start','period_end'])='{}'::jsonb THEN
   PERFORM public.set_statement_reconciliation_scope(p_document_id,(p_payload->>'account_id')::uuid,(p_payload->>'period_start')::date,(p_payload->>'period_end')::date);
 ELSIF v_action='confirm' AND (p_payload-ARRAY['action','observation_id','transaction_id'])='{}'::jsonb THEN
   PERFORM public.confirm_statement_reconciliation(p_document_id,(p_payload->>'observation_id')::uuid,(p_payload->>'transaction_id')::uuid);
 ELSIF v_action='undo' AND (p_payload-ARRAY['action','link_id'])='{}'::jsonb AND EXISTS(SELECT 1 FROM public.statement_reconciliation_links WHERE id=(p_payload->>'link_id')::uuid AND user_id=v_user AND document_id=p_document_id) THEN
   PERFORM public.undo_statement_reconciliation((p_payload->>'link_id')::uuid);
 ELSE RAISE EXCEPTION 'Invalid reconciliation command'; END IF;
 INSERT INTO public.statement_reconciliation_commands(user_id,request_id,document_id,payload) VALUES(v_user,p_request_id,p_document_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.apply_statement_reconciliation_command(uuid,uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.apply_statement_reconciliation_command(uuid,uuid,jsonb) TO authenticated;
