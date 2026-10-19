-- Explicitly reviewed missing movements may be posted and reconciled in one transaction.
CREATE TABLE public.statement_transaction_requests (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
 observation_id uuid NOT NULL REFERENCES public.document_observations(id) ON DELETE CASCADE,
 transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,request_id), UNIQUE(transaction_id)
);
ALTER TABLE public.statement_transaction_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.statement_transaction_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER statement_transaction_request_immutable BEFORE UPDATE OR DELETE ON public.statement_transaction_requests
 FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();

CREATE OR REPLACE FUNCTION public.guard_statement_financial_posting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.source='statement' OR EXISTS(SELECT 1 FROM public.documents d WHERE d.user_id=NEW.user_id
   AND d.document_type='statement' AND d.id::text=NEW.parsed_data->>'document_id') THEN
  IF NOT EXISTS(SELECT 1 FROM public.statement_transaction_requests r WHERE r.transaction_id=NEW.id
    AND r.user_id=NEW.user_id AND r.document_id::text=NEW.parsed_data->>'document_id'
    AND r.observation_id::text=NEW.parsed_data->>'observation_id' AND NEW.source='statement') THEN
   RAISE EXCEPTION 'An explicitly reviewed statement movement is required' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.create_statement_transaction(p_request_id uuid,p_document_id uuid,p_observation_id uuid,p_category_id uuid,p_description text,p_transfer_account_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 v_user uuid:=auth.uid(); s public.statement_reconciliation_scopes; o public.document_observations;
 a public.accounts; existing public.statement_transaction_requests; v_payload jsonb; v_transaction uuid:=gen_random_uuid();
 v_type text; v_date date; v_month text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM'); v_used integer; v_limit integer;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication and current terms required' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid statement transaction'; END IF;
 v_payload:=jsonb_build_object('observation_id',p_observation_id,'category_id',p_category_id,'description',btrim(p_description),'transfer_account_id',p_transfer_account_id);
 -- Match the manual writer's owner lock, then document, account and usage lock order.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual:'||v_user::text,0));
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user AND document_type='statement'
   AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO existing FROM public.statement_transaction_requests WHERE user_id=v_user AND request_id=p_request_id;
 IF FOUND THEN
  IF existing.document_id IS DISTINCT FROM p_document_id OR existing.payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'Request key already used'; END IF;
  RETURN jsonb_build_object('transaction_id',existing.transaction_id);
 END IF;
 SELECT * INTO s FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement scope not found'; END IF;
 PERFORM 1 FROM public.accounts WHERE user_id=v_user AND id IN (s.account_id,p_transfer_account_id) ORDER BY id FOR UPDATE;
 SELECT * INTO a FROM public.accounts WHERE id=s.account_id AND user_id=v_user AND deleted_at IS NULL AND is_active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 SELECT * INTO o FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND OR o.status<>'pending' OR o.amount IS NULL OR o.amount=0 OR o.currency IS DISTINCT FROM a.currency
   OR o.occurred_at_text IS NULL OR o.occurred_at_text !~ '^\d{4}-\d{2}-\d{2}($|T)' THEN RAISE EXCEPTION 'Verified statement evidence is required'; END IF;
 v_date:=left(o.occurred_at_text,10)::date;
 IF v_date::text<>left(o.occurred_at_text,10) OR v_date NOT BETWEEN s.period_start AND s.period_end THEN RAISE EXCEPTION 'Statement date is outside its period'; END IF;
 IF EXISTS(SELECT 1 FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id
   WHERE l.observation_id=o.id AND r.link_id IS NULL) THEN RAISE EXCEPTION 'Movement already linked'; END IF;
 IF p_transfer_account_id IS NOT NULL THEN
  IF p_transfer_account_id=a.id THEN RAISE EXCEPTION 'Transfer accounts must differ'; END IF;
  PERFORM 1 FROM public.accounts WHERE id=p_transfer_account_id AND user_id=v_user AND deleted_at IS NULL AND is_active AND currency=a.currency FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer account not found'; END IF;
 END IF;
 v_type:=CASE WHEN p_transfer_account_id IS NOT NULL THEN 'transfer' WHEN o.amount>0 THEN 'income' ELSE 'expense' END;
 IF v_type='transfer' AND p_category_id IS NOT NULL THEN RAISE EXCEPTION 'Transfers cannot have a category'; END IF;
 IF p_category_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.categories WHERE id=p_category_id
   AND (user_id=v_user OR user_id IS NULL) AND type=v_type AND is_active AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Category does not match'; END IF;
 -- A possible existing payment must be reviewed rather than silently posted again.
 IF EXISTS(SELECT 1 FROM public.transactions WHERE user_id=v_user AND deleted_at IS NULL
   AND date=v_date AND amount=abs(o.amount) AND (account_id=a.id OR transfer_to_account_id=a.id)) THEN
  RAISE EXCEPTION 'Possible existing transaction; review matches before creating' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.usage_tracking(user_id,month) VALUES(v_user,v_month) ON CONFLICT DO NOTHING;
 SELECT transactions_count INTO v_used FROM public.usage_tracking WHERE user_id=v_user AND month=v_month FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE user_id=v_user AND plan='pro' AND status='active') THEN
  SELECT coalesce((SELECT value::integer FROM public.app_settings WHERE key='free_transactions_limit'),50) INTO v_limit;
  IF v_used>=v_limit THEN RAISE EXCEPTION 'Transaction limit exceeded'; END IF;
 END IF;
 INSERT INTO public.statement_transaction_requests(user_id,request_id,document_id,observation_id,transaction_id,payload)
 VALUES(v_user,p_request_id,p_document_id,p_observation_id,v_transaction,v_payload);
 INSERT INTO public.transactions(id,user_id,account_id,amount,currency,date,time,type,description,category_id,transfer_to_account_id,source,raw_text,parsed_data)
 VALUES(v_transaction,v_user,CASE WHEN v_type='transfer' AND o.amount>0 THEN p_transfer_account_id ELSE a.id END,abs(o.amount),o.currency,v_date,'00:00',v_type,btrim(p_description),p_category_id,CASE WHEN v_type='transfer' THEN CASE WHEN o.amount>0 THEN a.id ELSE p_transfer_account_id END END,'statement',o.source_excerpt,
   jsonb_build_object('document_id',p_document_id,'observation_id',p_observation_id,'time_unknown',true));
 UPDATE public.accounts SET balance=coalesce(balance,0)+o.amount WHERE id=a.id AND user_id=v_user;
 IF p_transfer_account_id IS NOT NULL THEN UPDATE public.accounts SET balance=coalesce(balance,0)-o.amount WHERE id=p_transfer_account_id AND user_id=v_user; END IF;
 UPDATE public.usage_tracking SET transactions_count=transactions_count+1,updated_at=now() WHERE user_id=v_user AND month=v_month;
 PERFORM public.confirm_statement_reconciliation(p_document_id,p_observation_id,v_transaction);
 RETURN jsonb_build_object('transaction_id',v_transaction);
END $$;
REVOKE ALL ON FUNCTION public.create_statement_transaction(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_statement_transaction(uuid,uuid,uuid,uuid,text,uuid) TO authenticated;
