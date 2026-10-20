-- Preserve each currency side of an explicitly reviewed statement transfer.
CREATE OR REPLACE FUNCTION public.enforce_transaction_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account_currency text;
  v_account_owner uuid;
  v_destination_currency text;
  v_destination_owner uuid;
BEGIN
  SELECT a.currency, a.user_id INTO v_account_currency, v_account_owner
  FROM public.accounts AS a WHERE a.id = NEW.account_id;
  IF v_account_owner IS NULL OR v_account_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'Transaction account does not belong to owner' USING ERRCODE = '42501';
  END IF;

  -- Legacy writers only produce COP. An omitted currency on a USD account
  -- must fail closed until that writer explicitly supports USD.
  IF NEW.currency IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.currency := 'COP';
    ELSE
      RAISE EXCEPTION 'Historical transaction currency requires review'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_account_currency IS NULL OR v_account_currency NOT IN ('COP', 'USD')
    OR NEW.currency NOT IN ('COP', 'USD') OR NEW.currency <> v_account_currency THEN
    RAISE EXCEPTION 'Transaction currency must match account currency'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.source_currency IS NULL THEN
    NEW.source_currency := NEW.currency;
  END IF;
  IF NEW.source_currency IS NULL THEN
    IF NEW.source_amount IS NOT NULL OR NEW.fx_rate IS NOT NULL
      OR NEW.fx_rate_source IS NOT NULL OR NEW.fx_effective_date IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown historical source cannot carry exchange rate data'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.source_currency IS NOT NULL THEN
      RAISE EXCEPTION 'Reviewed source currency cannot be cleared'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.source_currency NOT IN ('COP', 'USD') THEN
      RAISE EXCEPTION 'Unsupported source currency' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.amount IS DISTINCT FROM OLD.amount
      AND OLD.source_currency = OLD.currency AND NEW.source_currency = NEW.currency
      AND OLD.source_amount = OLD.amount AND NEW.source_amount = OLD.source_amount THEN
      NEW.source_amount := NEW.amount;
    END IF;
    IF NEW.source_amount IS NULL THEN
      IF NEW.source_currency <> NEW.currency THEN
        RAISE EXCEPTION 'Original amount is required for exchange rate'
          USING ERRCODE = '23514';
      END IF;
      NEW.source_amount := NEW.amount;
    END IF;
    IF NEW.source_amount <= 0 THEN
      RAISE EXCEPTION 'Original amount must be positive' USING ERRCODE = '23514';
    END IF;

    IF NEW.source_currency = NEW.currency THEN
      IF NEW.source_amount <> NEW.amount OR NEW.fx_rate IS NOT NULL
        OR NEW.fx_rate_source IS NOT NULL OR NEW.fx_effective_date IS NOT NULL THEN
        RAISE EXCEPTION 'Same-currency amount cannot carry exchange rate data'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.fx_rate IS NULL OR NEW.fx_rate <= 0 OR NEW.fx_rate_source IS NULL
        OR NEW.fx_effective_date IS NULL
        OR abs(round(NEW.source_amount * NEW.fx_rate, 2) - NEW.amount) > 0.01 THEN
        RAISE EXCEPTION 'Original and posted amounts require a consistent exchange rate'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.transfer_to_account_id IS NOT NULL THEN
    IF NEW.type <> 'transfer' OR NEW.transfer_to_account_id = NEW.account_id THEN
      RAISE EXCEPTION 'Invalid transfer destination' USING ERRCODE = '23514';
    END IF;
    SELECT a.currency, a.user_id INTO v_destination_currency, v_destination_owner
    FROM public.accounts AS a WHERE a.id = NEW.transfer_to_account_id;
    IF v_destination_owner IS NULL OR v_destination_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'Transfer account does not belong to owner' USING ERRCODE = '42501';
    END IF;
    IF v_destination_currency <> NEW.currency THEN
      IF NEW.source <> 'statement' OR NEW.destination_amount IS NULL OR NEW.destination_amount <= 0
        OR NEW.source_currency IS DISTINCT FROM v_destination_currency
        OR NEW.destination_amount IS DISTINCT FROM NEW.source_amount
        OR NOT EXISTS(SELECT 1 FROM public.statement_transaction_requests r WHERE r.transaction_id=NEW.id AND r.user_id=NEW.user_id)
      THEN RAISE EXCEPTION 'Cross-currency transfer requires an atomic two-leg writer' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END IF;
    NEW.destination_amount := coalesce(NEW.destination_amount, NEW.amount);
    IF NEW.destination_amount <> NEW.amount THEN
      RAISE EXCEPTION 'Same-currency transfer amounts must match'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.destination_amount IS NOT NULL THEN
    RAISE EXCEPTION 'Destination amount requires a transfer account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.statement_transaction_snapshot(p public.transactions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('amount',p.amount,'currency',p.currency,'date',p.date,'type',p.type,'account_id',p.account_id,'transfer_to_account_id',p.transfer_to_account_id) || CASE WHEN p.type='transfer' AND p.source_currency IS NOT NULL AND p.currency IS NOT NULL AND p.source_currency<>p.currency THEN jsonb_build_object('destination_amount',p.destination_amount,'source_currency',p.source_currency,'source_amount',p.source_amount,'fx_rate',p.fx_rate,'fx_rate_source',p.fx_rate_source,'fx_effective_date',p.fx_effective_date) ELSE '{}'::jsonb END
$$;

CREATE OR REPLACE VIEW public.statement_reconciliation_proofs WITH (security_barrier=true) AS
 SELECT l.id,l.user_id,l.document_id,l.observation_id,l.transaction_id,l.created_at,d.file_name,
   (r.link_id IS NULL AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND (a.currency=t.currency OR (t.type='transfer' AND t.transfer_to_account_id=a.id AND a.currency=t.source_currency AND t.destination_amount=t.source_amount))
    AND l.transaction_snapshot=public.statement_transaction_snapshot(t)
    AND l.observation_snapshot=public.statement_observation_snapshot(o)) AS valid
 FROM public.statement_reconciliation_links l
 JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
 JOIN public.document_observations o ON o.id=l.observation_id AND o.user_id=l.user_id
 JOIN public.documents d ON d.id=l.document_id AND d.user_id=l.user_id
 JOIN public.accounts a ON a.id=l.account_id AND a.user_id=l.user_id
 LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id
 WHERE l.user_id=(SELECT auth.uid()) AND r.link_id IS NULL;
REVOKE ALL ON public.statement_reconciliation_proofs FROM PUBLIC,anon;
GRANT SELECT ON public.statement_reconciliation_proofs TO authenticated;


CREATE OR REPLACE FUNCTION public.confirm_statement_reconciliation(p_document_id uuid,p_observation_id uuid,p_transaction_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); s public.statement_reconciliation_scopes; o public.document_observations; t public.transactions; v_id uuid; v_signed numeric; v_currency text;
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
 ELSIF t.type='transfer' AND t.transfer_to_account_id=s.account_id THEN v_signed:=coalesce(t.destination_amount,t.amount);
 ELSE RAISE EXCEPTION 'Account or direction does not match'; END IF;
 SELECT currency INTO v_currency FROM public.accounts WHERE id=s.account_id AND user_id=v_user;
 IF t.account_id=s.account_id AND v_currency IS DISTINCT FROM t.currency THEN RAISE EXCEPTION 'Account currency does not match'; END IF;
 IF o.status='rejected' OR o.amount IS NULL OR o.amount<>v_signed OR o.currency IS DISTINCT FROM v_currency
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


CREATE OR REPLACE FUNCTION public.soft_delete_transactions(p_transaction_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_account_ids uuid[];
  v_account_id uuid;
  v_tx public.transactions%ROWTYPE;
  v_deleted integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_transaction_ids IS NULL OR cardinality(p_transaction_ids) NOT BETWEEN 1 AND 2000
    OR array_position(p_transaction_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Provide between 1 and 2000 transaction IDs' USING ERRCODE = '22023';
  END IF;

  -- Lock accounts before transactions, as in the manual creation RPC. Recheck
  -- each transaction after locking because another writer may have edited it.
  SELECT array_agg(id ORDER BY id) INTO v_account_ids FROM (
    SELECT account_id AS id FROM public.transactions
      WHERE user_id = v_user AND id = ANY(p_transaction_ids) AND deleted_at IS NULL
    UNION
    SELECT transfer_to_account_id AS id FROM public.transactions
      WHERE user_id = v_user AND id = ANY(p_transaction_ids)
        AND deleted_at IS NULL AND transfer_to_account_id IS NOT NULL
  ) account_ids;
  FOR v_account_id IN SELECT unnest(coalesce(v_account_ids, ARRAY[]::uuid[])) ORDER BY 1 LOOP
    PERFORM 1 FROM public.accounts
      WHERE id = v_account_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction account does not belong to caller'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR v_tx IN SELECT * FROM public.transactions
    WHERE user_id = v_user AND id = ANY(p_transaction_ids) AND deleted_at IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF v_account_ids IS NULL OR v_tx.account_id <> ALL(v_account_ids)
      OR (v_tx.transfer_to_account_id IS NOT NULL
        AND v_tx.transfer_to_account_id <> ALL(v_account_ids)) THEN
      RAISE EXCEPTION 'Transaction accounts changed during deletion'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.transaction_deletion_decisions(user_id,transaction_id,before_state)
      VALUES (v_user,v_tx.id,jsonb_build_object(
        'type',v_tx.type,'amount',v_tx.amount,'account_id',v_tx.account_id,
        'transfer_to_account_id',v_tx.transfer_to_account_id,'destination_amount',v_tx.destination_amount));

    UPDATE public.transactions SET deleted_at = now()
      WHERE id = v_tx.id AND user_id = v_user;
    IF v_tx.type = 'expense' THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) + v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
    ELSIF v_tx.type = 'income' THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) - v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
    ELSIF v_tx.type = 'transfer' AND v_tx.transfer_to_account_id IS NOT NULL THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) + v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
      UPDATE public.accounts SET balance = coalesce(balance, 0) - coalesce(v_tx.destination_amount,v_tx.amount)
        WHERE id = v_tx.transfer_to_account_id AND user_id = v_user;
    END IF;
    v_deleted := v_deleted + 1;
  END LOOP;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.soft_delete_transactions(uuid[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_transactions(uuid[])
  TO authenticated;

CREATE FUNCTION public.guard_converted_statement_finance() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.type='transfer' AND OLD.source='statement' AND OLD.source_currency IS NOT NULL AND OLD.currency IS NOT NULL AND OLD.source_currency<>OLD.currency
 AND (OLD.amount,OLD.currency,OLD.account_id,OLD.transfer_to_account_id,OLD.type,OLD.date,OLD.time,OLD.source_amount,OLD.source_currency,OLD.destination_amount,OLD.fx_rate,OLD.fx_rate_source,OLD.fx_effective_date)
 IS DISTINCT FROM (NEW.amount,NEW.currency,NEW.account_id,NEW.transfer_to_account_id,NEW.type,NEW.date,NEW.time,NEW.source_amount,NEW.source_currency,NEW.destination_amount,NEW.fx_rate,NEW.fx_rate_source,NEW.fx_effective_date)
 THEN RAISE EXCEPTION 'Converted transfer requires a dedicated financial review' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER converted_statement_finance_guard BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.guard_converted_statement_finance();

CREATE FUNCTION public.create_converted_statement_transaction(p_request_id uuid,p_document_id uuid,p_observation_id uuid,p_description text,p_funding_account_id uuid,p_funding_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); scope public.statement_currency_scopes; observation public.document_observations;
 destination public.accounts; funding public.accounts; previous public.statement_transaction_requests;
 payload jsonb; tx uuid:=gen_random_uuid(); event_date date; month_key text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM'); used integer; quota integer;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_request_id IS NULL OR length(btrim(coalesce(p_description,''))) NOT BETWEEN 1 AND 500 OR p_funding_amount IS NULL OR p_funding_amount<=0 OR p_funding_amount>9999999999999.99 OR round(p_funding_amount,2)<>p_funding_amount THEN RAISE EXCEPTION 'Invalid reviewed conversion'; END IF;
 payload:=jsonb_build_object('observation_id',p_observation_id,'description',btrim(p_description),'funding_account_id',p_funding_account_id,'funding_amount',p_funding_amount);
 PERFORM pg_advisory_xact_lock(hashtextextended('manual:'||owner::text,0));
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=owner AND document_type='statement' AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 SELECT * INTO previous FROM public.statement_transaction_requests WHERE user_id=owner AND request_id=p_request_id;
 IF FOUND THEN
  IF previous.document_id IS DISTINCT FROM p_document_id OR previous.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Request key already used'; END IF;
  RETURN jsonb_build_object('transaction_id',previous.transaction_id);
 END IF;
 SELECT * INTO observation FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=owner;
 IF NOT FOUND THEN RAISE EXCEPTION 'Observation not found'; END IF;
 SELECT * INTO scope FROM public.statement_currency_scopes WHERE document_id=p_document_id AND user_id=owner AND currency=observation.currency;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement scope not found'; END IF;
 PERFORM 1 FROM public.accounts WHERE user_id=owner AND id IN (scope.account_id,p_funding_account_id) ORDER BY id FOR UPDATE;
 SELECT * INTO destination FROM public.accounts WHERE id=scope.account_id AND user_id=owner AND is_active AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 SELECT * INTO funding FROM public.accounts WHERE id=p_funding_account_id AND user_id=owner AND is_active AND deleted_at IS NULL;
 IF NOT FOUND OR funding.id=destination.id OR funding.currency=destination.currency OR funding.currency NOT IN ('COP','USD') OR destination.currency NOT IN ('COP','USD') THEN RAISE EXCEPTION 'Review funding account'; END IF;
 SELECT * INTO observation FROM public.document_observations WHERE id=p_observation_id AND document_id=p_document_id AND user_id=owner FOR UPDATE;
 IF observation.status<>'pending' OR observation.amount IS NULL OR observation.amount<=0 OR observation.currency IS DISTINCT FROM destination.currency OR observation.occurred_at_text IS NULL OR observation.occurred_at_text !~ '^\d{4}-\d{2}-\d{2}($|T)' THEN RAISE EXCEPTION 'Verified positive statement evidence is required'; END IF;
 event_date:=left(observation.occurred_at_text,10)::date;
 IF event_date NOT BETWEEN scope.period_start AND scope.period_end THEN RAISE EXCEPTION 'Statement date is outside its period'; END IF;
 IF EXISTS(SELECT 1 FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id WHERE l.observation_id=observation.id AND r.link_id IS NULL) THEN RAISE EXCEPTION 'Movement already linked'; END IF;
 IF EXISTS(SELECT 1 FROM public.transactions t WHERE t.user_id=owner AND t.deleted_at IS NULL AND t.date=event_date AND (
   (t.account_id=funding.id AND t.amount=p_funding_amount) OR (t.account_id=destination.id AND t.amount=observation.amount) OR (t.transfer_to_account_id=destination.id AND coalesce(t.destination_amount,t.amount)=observation.amount))) THEN RAISE EXCEPTION 'Possible existing transaction; review before creating' USING ERRCODE='23505'; END IF;
 INSERT INTO public.usage_tracking(user_id,month) VALUES(owner,month_key) ON CONFLICT DO NOTHING;
 SELECT transactions_count INTO used FROM public.usage_tracking WHERE user_id=owner AND month=month_key FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE user_id=owner AND plan='pro' AND status='active') THEN
  SELECT coalesce((SELECT value::integer FROM public.app_settings WHERE key='free_transactions_limit'),50) INTO quota;
  IF used>=quota THEN RAISE EXCEPTION 'Transaction limit exceeded'; END IF;
 END IF;
 INSERT INTO public.statement_transaction_requests(user_id,request_id,document_id,observation_id,transaction_id,payload) VALUES(owner,p_request_id,p_document_id,p_observation_id,tx,payload);
 INSERT INTO public.transactions(id,user_id,account_id,transfer_to_account_id,amount,currency,source_currency,source_amount,destination_amount,fx_rate,fx_rate_source,fx_effective_date,date,time,type,description,source,raw_text,parsed_data)
 VALUES(tx,owner,funding.id,destination.id,p_funding_amount,funding.currency,observation.currency,observation.amount,observation.amount,p_funding_amount/observation.amount,'manual',event_date,event_date,'00:00','transfer',btrim(p_description),'statement',observation.source_excerpt,jsonb_build_object('document_id',p_document_id,'observation_id',p_observation_id,'time_unknown',true,'funding_amount_reviewed',true));
 UPDATE public.accounts SET balance=coalesce(balance,0)-p_funding_amount WHERE id=funding.id AND user_id=owner;
 UPDATE public.accounts SET balance=coalesce(balance,0)+observation.amount WHERE id=destination.id AND user_id=owner;
 UPDATE public.usage_tracking SET transactions_count=transactions_count+1,updated_at=now() WHERE user_id=owner AND month=month_key;
 PERFORM public.confirm_statement_reconciliation(p_document_id,p_observation_id,tx);
 RETURN jsonb_build_object('transaction_id',tx);
END $$;
REVOKE ALL ON FUNCTION public.create_converted_statement_transaction(uuid,uuid,uuid,text,uuid,numeric) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_converted_statement_transaction(uuid,uuid,uuid,text,uuid,numeric) TO authenticated;
