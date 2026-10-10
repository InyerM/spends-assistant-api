-- Reconciliation is evidence only, independent of receipt provenance and posting.
CREATE TABLE public.statement_reconciliation_scopes (
  document_id uuid PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  CHECK (period_end >= period_start AND period_end - period_start <= 366)
);
CREATE TABLE public.statement_reconciliation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.statement_reconciliation_scopes(document_id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES public.document_observations(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  transaction_snapshot jsonb NOT NULL,
  observation_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX statement_links_owner_transaction ON public.statement_reconciliation_links(user_id,transaction_id);
CREATE INDEX statement_links_document ON public.statement_reconciliation_links(document_id);
CREATE TABLE public.statement_reconciliation_reversals (
  link_id uuid PRIMARY KEY REFERENCES public.statement_reconciliation_links(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.statement_reconciliation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statement_reconciliation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statement_reconciliation_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY statement_scope_owner ON public.statement_reconciliation_scopes FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY statement_link_owner ON public.statement_reconciliation_links FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
CREATE POLICY statement_reversal_owner ON public.statement_reconciliation_reversals FOR SELECT TO authenticated USING (user_id=(SELECT auth.uid()));
REVOKE ALL ON public.statement_reconciliation_scopes,public.statement_reconciliation_links,public.statement_reconciliation_reversals FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.statement_reconciliation_scopes,public.statement_reconciliation_links,public.statement_reconciliation_reversals TO authenticated;

CREATE FUNCTION public.statement_transaction_snapshot(p public.transactions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('amount',p.amount,'currency',p.currency,'date',p.date,'type',p.type,'account_id',p.account_id,'transfer_to_account_id',p.transfer_to_account_id)
$$;
CREATE FUNCTION public.statement_observation_snapshot(p public.document_observations) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('amount',p.amount,'currency',p.currency,'date',p.occurred_at_text)
$$;
CREATE VIEW public.statement_reconciliation_proofs WITH (security_barrier=true) AS
 SELECT l.id,l.user_id,l.document_id,l.observation_id,l.transaction_id,l.created_at,d.file_name,
   (r.link_id IS NULL AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.currency=t.currency
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

CREATE FUNCTION public.set_statement_reconciliation_scope(p_document_id uuid,p_account_id uuid,p_period_start date,p_period_end date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); v_scope public.statement_reconciliation_scopes;
BEGIN
 IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user AND document_type='statement' AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 PERFORM 1 FROM public.accounts WHERE id=p_account_id AND user_id=v_user AND deleted_at IS NULL AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<p_period_start OR p_period_end-p_period_start>366 THEN RAISE EXCEPTION 'Invalid statement period'; END IF;
 SELECT * INTO v_scope FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id FOR UPDATE;
 IF FOUND AND (v_scope.account_id,v_scope.period_start,v_scope.period_end) IS DISTINCT FROM (p_account_id,p_period_start,p_period_end)
 AND EXISTS(SELECT 1 FROM public.statement_reconciliation_links l LEFT JOIN public.statement_reconciliation_reversals r ON r.link_id=l.id WHERE l.document_id=p_document_id AND r.link_id IS NULL)
 THEN RAISE EXCEPTION 'Undo reconciliations before changing scope'; END IF;
 INSERT INTO public.statement_reconciliation_scopes VALUES(p_document_id,v_user,p_account_id,p_period_start,p_period_end)
 ON CONFLICT(document_id) DO UPDATE SET account_id=excluded.account_id,period_start=excluded.period_start,period_end=excluded.period_end;
END $$;

CREATE FUNCTION public.confirm_statement_reconciliation(p_document_id uuid,p_observation_id uuid,p_transaction_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); s public.statement_reconciliation_scopes; o public.document_observations; t public.transactions; v_id uuid; v_signed numeric;
BEGIN
 IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=v_user AND document_type='statement' AND status='extracted' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found'; END IF;
 SELECT * INTO s FROM public.statement_reconciliation_scopes WHERE document_id=p_document_id AND user_id=v_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement scope not found'; END IF;
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
CREATE FUNCTION public.undo_statement_reconciliation(p_link_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); v_document uuid;
BEGIN
 SELECT document_id INTO v_document FROM public.statement_reconciliation_links WHERE id=p_link_id AND user_id=v_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation not found'; END IF;
 PERFORM 1 FROM public.documents WHERE id=v_document AND user_id=v_user FOR UPDATE;
 INSERT INTO public.statement_reconciliation_reversals(link_id,user_id) VALUES(p_link_id,v_user) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.set_statement_reconciliation_scope(uuid,uuid,date,date),public.confirm_statement_reconciliation(uuid,uuid,uuid),public.undo_statement_reconciliation(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_statement_reconciliation_scope(uuid,uuid,date,date),public.confirm_statement_reconciliation(uuid,uuid,uuid),public.undo_statement_reconciliation(uuid) TO authenticated;

CREATE FUNCTION public.guard_statement_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Statement reconciliation audit is immutable';
END $$;
CREATE TRIGGER statement_link_immutable BEFORE UPDATE OR DELETE ON public.statement_reconciliation_links FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();
CREATE TRIGGER statement_reversal_immutable BEFORE UPDATE OR DELETE ON public.statement_reconciliation_reversals FOR EACH ROW EXECUTE FUNCTION public.guard_statement_audit_mutation();

CREATE FUNCTION public.guard_statement_financial_posting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.documents d WHERE d.user_id=NEW.user_id AND d.document_type='statement'
   AND d.id::text=to_jsonb(NEW)->'parsed_data'->>'document_id')
 THEN RAISE EXCEPTION 'Statements are reconciliation evidence, not transaction intake'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transactions_statement_posting_guard BEFORE INSERT ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.guard_statement_financial_posting();

CREATE OR REPLACE FUNCTION public.pending_document_count()
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT count(*) FROM public.documents d
 WHERE d.user_id=(SELECT auth.uid()) AND d.archived_at IS NULL
 AND (d.status IN ('uploaded','processing','failed') OR EXISTS (
   SELECT 1 FROM public.document_observations o
   WHERE o.document_id=d.id AND o.user_id=d.user_id AND o.status='pending'
   AND NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_proofs p WHERE p.observation_id=o.id AND p.valid)
 ) OR (d.document_type='statement' AND NOT EXISTS(SELECT 1 FROM public.statement_reconciliation_scopes s WHERE s.document_id=d.id AND s.user_id=d.user_id)))
$$;
REVOKE ALL ON FUNCTION public.pending_document_count() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.pending_document_count() TO authenticated;
