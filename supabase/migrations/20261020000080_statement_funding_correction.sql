-- Correct only the funding leg while preserving the statement's original currency evidence.
CREATE TABLE public.statement_funding_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  write_transaction bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id)
);
ALTER TABLE public.statement_funding_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY statement_funding_correction_owner ON public.statement_funding_corrections
  FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
REVOKE ALL ON public.statement_funding_corrections FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.statement_funding_corrections TO authenticated;
CREATE TRIGGER statement_funding_correction_immutable BEFORE UPDATE OR DELETE ON public.statement_funding_corrections
  FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();

CREATE OR REPLACE FUNCTION public.guard_converted_statement_finance() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.type='transfer' AND OLD.source='statement' AND OLD.source_currency IS NOT NULL AND OLD.currency IS NOT NULL AND OLD.source_currency<>OLD.currency
 AND (OLD.amount,OLD.currency,OLD.account_id,OLD.transfer_to_account_id,OLD.type,OLD.date,OLD.time,OLD.source_amount,OLD.source_currency,OLD.destination_amount,OLD.fx_rate,OLD.fx_rate_source,OLD.fx_effective_date)
 IS DISTINCT FROM (NEW.amount,NEW.currency,NEW.account_id,NEW.transfer_to_account_id,NEW.type,NEW.date,NEW.time,NEW.source_amount,NEW.source_currency,NEW.destination_amount,NEW.fx_rate,NEW.fx_rate_source,NEW.fx_effective_date)
 THEN
  IF (OLD.currency,OLD.account_id,OLD.transfer_to_account_id,OLD.type,OLD.date,OLD.time,OLD.source_amount,OLD.source_currency,OLD.destination_amount,OLD.fx_rate_source,OLD.fx_effective_date)
     IS DISTINCT FROM (NEW.currency,NEW.account_id,NEW.transfer_to_account_id,NEW.type,NEW.date,NEW.time,NEW.source_amount,NEW.source_currency,NEW.destination_amount,NEW.fx_rate_source,NEW.fx_effective_date)
     OR NOT EXISTS(SELECT 1 FROM public.statement_funding_corrections e
       WHERE e.id::text=current_setting('app.statement_funding_correction',true)
         AND e.user_id=auth.uid() AND e.transaction_id=OLD.id AND e.write_transaction=txid_current()
         AND e.before_state=public.statement_transaction_snapshot(OLD)
         AND e.after_state=public.statement_transaction_snapshot(NEW))
  THEN RAISE EXCEPTION 'Converted transfer requires a dedicated financial review' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.correct_statement_funding_amount(p_request_id uuid,p_transaction_id uuid,p_expected_amount numeric,p_actual_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); original public.transactions; revised public.transactions;
 previous public.statement_funding_corrections; event_id uuid; link public.statement_reconciliation_links;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR p_actual_amount IS NULL OR p_actual_amount<=0 OR p_actual_amount>9999999999999.99 OR round(p_actual_amount,2)<>p_actual_amount
   OR p_expected_amount IS NULL OR p_expected_amount<=0 THEN RAISE EXCEPTION 'Invalid funding correction'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual:'||owner::text,0));
 SELECT * INTO previous FROM public.statement_funding_corrections WHERE user_id=owner AND request_id=p_request_id;
 IF FOUND THEN
  IF previous.transaction_id IS DISTINCT FROM p_transaction_id OR (previous.before_state->>'amount')::numeric IS DISTINCT FROM p_expected_amount
    OR (previous.after_state->>'amount')::numeric IS DISTINCT FROM p_actual_amount THEN RAISE EXCEPTION 'Request key already used'; END IF;
  RETURN jsonb_build_object('transaction_id',p_transaction_id,'correction_id',previous.id);
 END IF;
 SELECT * INTO original FROM public.transactions WHERE id=p_transaction_id AND user_id=owner AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.documents d WHERE d.user_id=owner AND EXISTS(SELECT 1 FROM public.statement_reconciliation_links l WHERE l.document_id=d.id AND l.transaction_id=p_transaction_id AND l.user_id=owner) ORDER BY d.id FOR UPDATE;
 PERFORM 1 FROM public.accounts WHERE user_id=owner AND id IN(original.account_id,original.transfer_to_account_id) ORDER BY id FOR UPDATE;
 SELECT * INTO original FROM public.transactions WHERE id=p_transaction_id AND user_id=owner AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR original.type<>'transfer' OR original.source<>'statement' OR original.currency IS DISTINCT FROM 'COP'
   OR original.source_currency IS DISTINCT FROM 'USD' OR original.destination_amount IS NULL OR original.destination_amount<=0
   OR original.destination_amount IS DISTINCT FROM original.source_amount OR original.fx_rate_source IS DISTINCT FROM 'manual'
 THEN RAISE EXCEPTION 'Reviewed converted statement payment required'; END IF;
 IF original.amount IS DISTINCT FROM p_expected_amount THEN RAISE EXCEPTION 'Funding amount changed; reload before correcting' USING ERRCODE='40001'; END IF;
 IF original.amount=p_actual_amount THEN RAISE EXCEPTION 'Funding amount has not changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=original.account_id AND user_id=owner AND currency=original.currency AND deleted_at IS NULL AND is_active)
 OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=original.transfer_to_account_id AND user_id=owner AND currency=original.source_currency AND deleted_at IS NULL AND is_active)
 THEN RAISE EXCEPTION 'Review payment accounts'; END IF;
 IF EXISTS(SELECT 1 FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id
   WHERE l.transaction_id=p_transaction_id AND l.user_id=owner AND r.link_id IS NULL
     AND (l.account_id IS DISTINCT FROM original.transfer_to_account_id OR NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs p WHERE p.id=l.id AND p.valid)))
 THEN RAISE EXCEPTION 'Review existing funding reconciliation before correcting' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs p WHERE p.transaction_id=p_transaction_id AND p.user_id=owner AND p.valid)
 THEN RAISE EXCEPTION 'Valid statement evidence required'; END IF;
 IF EXISTS(SELECT 1 FROM public.transactions t WHERE t.user_id=owner AND t.id<>original.id AND t.deleted_at IS NULL AND t.account_id=original.account_id AND t.currency=original.currency AND t.date=original.date AND t.amount=p_actual_amount)
 THEN RAISE EXCEPTION 'Possible existing funding debit; reconcile instead of duplicating' USING ERRCODE='23505'; END IF;
 revised:=original; revised.amount:=p_actual_amount; revised.fx_rate:=p_actual_amount/original.source_amount;
 INSERT INTO public.statement_funding_corrections(user_id,request_id,transaction_id,before_state,after_state)
 VALUES(owner,p_request_id,p_transaction_id,public.statement_transaction_snapshot(original),public.statement_transaction_snapshot(revised)) RETURNING id INTO event_id;
 PERFORM set_config('app.statement_funding_correction',event_id::text,true);
 UPDATE public.transactions SET amount=revised.amount,fx_rate=revised.fx_rate WHERE id=original.id AND user_id=owner;
 UPDATE public.accounts SET balance=coalesce(balance,0)+original.amount-p_actual_amount WHERE id=original.account_id AND user_id=owner;
 FOR link IN SELECT l.* FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id WHERE l.transaction_id=original.id AND l.user_id=owner AND r.link_id IS NULL LOOP
  INSERT INTO public.statement_reconciliation_reversals(link_id,user_id) VALUES(link.id,owner);
  INSERT INTO public.statement_reconciliation_links(user_id,document_id,observation_id,transaction_id,account_id,transaction_snapshot,observation_snapshot)
    VALUES(owner,link.document_id,link.observation_id,original.id,link.account_id,public.statement_transaction_snapshot(revised),link.observation_snapshot);
 END LOOP;
 PERFORM set_config('app.statement_funding_correction','',true);
 RETURN jsonb_build_object('transaction_id',p_transaction_id,'correction_id',event_id);
END $$;
REVOKE ALL ON FUNCTION public.correct_statement_funding_amount(uuid,uuid,numeric,numeric) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.correct_statement_funding_amount(uuid,uuid,numeric,numeric) TO authenticated;
