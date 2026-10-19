-- Cache derived inspection facts, never PDF passwords. Separate statement scopes by posting currency.
ALTER TABLE public.documents ADD COLUMN statement_metadata jsonb;
CREATE FUNCTION public.cache_statement_metadata(p_document_id uuid,p_owner_id uuid,p_metadata jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR length(p_metadata::text)>8000
 OR p_metadata ?| ARRAY['password','pages','text'] THEN RAISE EXCEPTION 'Invalid statement metadata'; END IF;
 UPDATE public.documents SET statement_metadata=p_metadata WHERE id=p_document_id AND user_id=p_owner_id AND mime_type='application/pdf' AND status IN ('processing','extracted');
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.cache_statement_metadata(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cache_statement_metadata(uuid,uuid,jsonb) TO service_role;
CREATE TABLE public.statement_currency_scopes (
 document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 currency text NOT NULL CHECK(currency IN ('COP','USD')),
 account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
 period_start date NOT NULL,period_end date NOT NULL,
 PRIMARY KEY(document_id,currency),CHECK(period_end>=period_start AND period_end-period_start<=366)
);
ALTER TABLE public.statement_currency_scopes ENABLE ROW LEVEL SECURITY;
CREATE POLICY statement_currency_scope_owner ON public.statement_currency_scopes FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()));
REVOKE ALL ON public.statement_currency_scopes FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.statement_currency_scopes TO authenticated;
CREATE FUNCTION public.set_statement_currency_scope(p_document_id uuid,p_account_id uuid,p_period_start date,p_period_end date,p_currency text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid();
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user AND document_type='statement' AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 PERFORM 1 FROM public.accounts WHERE id=p_account_id AND user_id=v_user AND currency=p_currency AND deleted_at IS NULL AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account currency does not match'; END IF;
 IF p_currency NOT IN ('COP','USD') OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<p_period_start OR p_period_end-p_period_start>366 THEN RAISE EXCEPTION 'Invalid statement period'; END IF;
 IF EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs p JOIN public.document_observations o ON o.id=p.observation_id
 WHERE p.document_id=p_document_id AND p.user_id=v_user AND o.currency=p_currency)
 AND NOT EXISTS(SELECT 1 FROM public.statement_currency_scopes WHERE document_id=p_document_id AND currency=p_currency AND user_id=v_user
 AND account_id=p_account_id AND period_start=p_period_start AND period_end=p_period_end) THEN
 -- A legacy scope can be adopted unchanged while its proofs remain intact.
 IF NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id AND user_id=v_user AND account_id=p_account_id AND period_start=p_period_start AND period_end=p_period_end) THEN RAISE EXCEPTION 'Undo this currency reconciliations before changing scope'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id) THEN
  PERFORM public.set_statement_reconciliation_scope(p_document_id,p_account_id,p_period_start,p_period_end);
 END IF;
 INSERT INTO public.statement_currency_scopes VALUES(p_document_id,v_user,p_currency,p_account_id,p_period_start,p_period_end)
 ON CONFLICT(document_id,currency) DO UPDATE SET account_id=excluded.account_id,period_start=excluded.period_start,period_end=excluded.period_end;
END $$;
REVOKE ALL ON FUNCTION public.set_statement_currency_scope(uuid,uuid,date,date,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.set_statement_currency_scope(uuid,uuid,date,date,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_statement_reconciliation(p_document_id uuid,p_observation_id uuid,p_transaction_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); s public.statement_reconciliation_scopes; o public.document_observations; t public.transactions; v_id uuid; v_signed numeric;
BEGIN
 IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user AND document_type='statement' AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 SELECT * INTO o FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
 SELECT p_document_id,v_user,account_id,period_start,period_end INTO s FROM public.statement_currency_scopes WHERE document_id=p_document_id AND user_id=v_user AND currency=o.currency;
 IF NOT FOUND THEN SELECT * INTO s FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id AND user_id=v_user; END IF;
 IF s.account_id IS NULL THEN RAISE EXCEPTION 'Statement scope not found'; END IF;
 PERFORM 1 FROM public.accounts WHERE id=s.account_id AND user_id=v_user AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 SELECT * INTO o FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
 SELECT * INTO t FROM public.transactions WHERE id=p_transaction_id AND user_id=v_user AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
 IF t.type='income' AND t.account_id=s.account_id THEN v_signed:=t.amount;
 ELSIF t.type IN ('expense','transfer') AND t.account_id=s.account_id THEN v_signed:=-t.amount;
 ELSIF t.type='transfer' AND t.transfer_to_account_id=s.account_id THEN v_signed:=t.amount;
 ELSE RAISE EXCEPTION 'Account or direction does not match'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=s.account_id AND user_id=v_user AND currency=t.currency) THEN RAISE EXCEPTION 'Account currency does not match'; END IF;
 IF o.status='rejected' OR o.amount IS NULL OR o.amount<>v_signed OR o.currency IS DISTINCT FROM t.currency
 OR o.occurred_at_text IS NULL OR o.occurred_at_text !~ '^\d{4}-\d{2}-\d{2}($|T)'
 OR left(o.occurred_at_text,10)<>t.date::text OR t.date NOT BETWEEN s.period_start AND s.period_end
 THEN RAISE EXCEPTION 'Statement evidence does not match transaction'; END IF;
 SELECT l.id INTO v_id FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id
 WHERE l.document_id=p_document_id AND r.link_id IS NULL AND (l.observation_id=p_observation_id OR l.transaction_id=p_transaction_id);
 IF FOUND THEN
 IF EXISTS(SELECT 1 FROM public.statement_reconciliation_links WHERE id=v_id AND observation_id=p_observation_id AND transaction_id=p_transaction_id AND transaction_snapshot=public.statement_transaction_snapshot(t) AND observation_snapshot=public.statement_observation_snapshot(o)) THEN RETURN v_id; END IF;
 RAISE EXCEPTION 'Movement already linked; undo before relinking'; END IF;
 INSERT INTO public.statement_reconciliation_links(user_id,document_id,observation_id,transaction_id,account_id,transaction_snapshot,observation_snapshot)
 VALUES(v_user,p_document_id,p_observation_id,p_transaction_id,s.account_id,public.statement_transaction_snapshot(t),public.statement_observation_snapshot(o)) RETURNING id INTO v_id;
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.create_statement_transaction(p_request_id uuid,p_document_id uuid,p_observation_id uuid,p_category_id uuid,p_description text,p_transfer_account_id uuid DEFAULT NULL)
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
 SELECT * INTO o FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=v_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
 SELECT p_document_id,v_user,account_id,period_start,period_end INTO s FROM public.statement_currency_scopes WHERE document_id=p_document_id AND user_id=v_user AND currency=o.currency;
 IF NOT FOUND THEN SELECT * INTO s FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id AND user_id=v_user; END IF;
 IF s.account_id IS NULL THEN RAISE EXCEPTION 'Statement scope not found'; END IF;
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
