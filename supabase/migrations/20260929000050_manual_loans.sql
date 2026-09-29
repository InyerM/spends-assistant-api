-- A reviewed loan ledger independent of accounts, transactions, and net worth.
-- No rate or payment component is inferred. Zero balances are distinguished from no opening.
CREATE TABLE public.manual_loan_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('manual_review', 'statement')),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 500),
  observed_on date NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE public.manual_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lender text NOT NULL CHECK (lender IN ('lulo_bank', 'bancolombia')),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  money_scale integer NOT NULL CHECK (money_scale BETWEEN 0 AND 6),
  opening_recorded boolean NOT NULL DEFAULT false,
  outstanding_minor text NOT NULL DEFAULT '0' CHECK (outstanding_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  interest_expense_minor text NOT NULL DEFAULT '0' CHECK (interest_expense_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  insurance_expense_minor text NOT NULL DEFAULT '0' CHECK (insurance_expense_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  fee_expense_minor text NOT NULL DEFAULT '0' CHECK (fee_expense_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  evidence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (evidence_id, user_id) REFERENCES public.manual_loan_evidence(id, user_id)
);
CREATE INDEX manual_loans_user_created_idx ON public.manual_loans(user_id, created_at DESC);

CREATE TABLE public.manual_loan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  loan_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'payment')),
  occurred_on date NOT NULL,
  cash_paid_minor text,
  principal_minor text NOT NULL CHECK (principal_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  interest_minor text,
  insurance_minor text,
  fee_minor text,
  outstanding_after_minor text NOT NULL CHECK (outstanding_after_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_id, user_id) REFERENCES public.manual_loans(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, user_id) REFERENCES public.manual_loan_evidence(id, user_id),
  CHECK ((kind = 'opening' AND cash_paid_minor IS NULL AND interest_minor IS NULL AND insurance_minor IS NULL AND fee_minor IS NULL)
    OR (kind = 'payment' AND cash_paid_minor ~ '^[1-9][0-9]{0,37}$'
      AND interest_minor ~ '^(0|[1-9][0-9]{0,37})$'
      AND insurance_minor ~ '^(0|[1-9][0-9]{0,37})$'
      AND fee_minor ~ '^(0|[1-9][0-9]{0,37})$'))
);
CREATE UNIQUE INDEX manual_loan_one_opening_idx ON public.manual_loan_events(loan_id) WHERE kind = 'opening';
CREATE INDEX manual_loan_events_owner_date_idx ON public.manual_loan_events(user_id, loan_id, occurred_on DESC, created_at DESC);

CREATE TABLE public.manual_loan_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);

ALTER TABLE public.manual_loan_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_loan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_loan_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY manual_loan_evidence_owner ON public.manual_loan_evidence FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY manual_loans_owner ON public.manual_loans FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY manual_loan_events_owner ON public.manual_loan_events FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY manual_loan_requests_owner ON public.manual_loan_requests FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY manual_loan_evidence_service ON public.manual_loan_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY manual_loans_service ON public.manual_loans FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY manual_loan_events_service ON public.manual_loan_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY manual_loan_requests_service ON public.manual_loan_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.manual_loan_evidence, public.manual_loans, public.manual_loan_events, public.manual_loan_requests FROM anon, authenticated;
GRANT SELECT ON public.manual_loan_evidence, public.manual_loans, public.manual_loan_events, public.manual_loan_requests TO authenticated;
GRANT ALL ON public.manual_loan_evidence, public.manual_loans, public.manual_loan_events, public.manual_loan_requests TO service_role;

CREATE FUNCTION public.confirm_loan_event(p_request_id uuid, p_reviewed boolean, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_prior public.manual_loan_requests%ROWTYPE;
  v_loan public.manual_loans%ROWTYPE;
  v_action text;
  v_loan_id uuid;
  v_evidence_id uuid;
  v_id uuid;
  v_paid numeric;
  v_principal numeric;
  v_interest numeric;
  v_insurance numeric;
  v_fee numeric;
  v_outstanding numeric;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_request_id IS NULL OR p_reviewed IS DISTINCT FROM true OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Explicit review and request ID required' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(p_event::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_prior FROM public.manual_loan_requests WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'Request ID belongs to another entry' USING ERRCODE = '22023'; END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;
  v_action := p_event->>'action';
  IF coalesce(v_action, '') NOT IN ('create_loan', 'opening', 'payment')
    OR jsonb_typeof(p_event->'evidence') IS DISTINCT FROM 'object'
    OR coalesce(p_event->'evidence'->>'kind', '') NOT IN ('manual_review', 'statement')
    OR length(trim(coalesce(p_event->'evidence'->>'reference', ''))) NOT BETWEEN 1 AND 500
    OR coalesce(p_event->'evidence'->>'observed_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid loan entry or evidence' USING ERRCODE = '22023';
  END IF;
  IF v_action = 'create_loan' THEN
    IF coalesce(p_event->>'lender', '') NOT IN ('lulo_bank', 'bancolombia')
      OR length(trim(coalesce(p_event->>'label', ''))) NOT BETWEEN 1 AND 100
      OR coalesce(p_event->>'currency', '') !~ '^[A-Z]{3}$'
      OR coalesce(p_event->>'money_scale', '') !~ '^[0-6]$' THEN
      RAISE EXCEPTION 'Invalid loan metadata' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF coalesce(p_event->>'loan_id', '') !~ '^[0-9a-fA-F-]{36}$'
      OR coalesce(p_event->>'occurred_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid loan reference or date' USING ERRCODE = '22023';
    END IF;
    v_loan_id := (p_event->>'loan_id')::uuid;
    SELECT * INTO v_loan FROM public.manual_loans WHERE id = v_loan_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found' USING ERRCODE = '42501'; END IF;
  END IF;
  INSERT INTO public.manual_loan_evidence(user_id, kind, reference, observed_on)
  VALUES(v_user, p_event->'evidence'->>'kind', trim(p_event->'evidence'->>'reference'), (p_event->'evidence'->>'observed_on')::date)
  RETURNING id INTO v_evidence_id;
  IF v_action = 'create_loan' THEN
    INSERT INTO public.manual_loans(user_id, lender, label, currency, money_scale, evidence_id)
    VALUES(v_user, p_event->>'lender', trim(p_event->>'label'), p_event->>'currency', (p_event->>'money_scale')::integer, v_evidence_id)
    RETURNING id INTO v_loan_id;
    v_id := v_loan_id;
    v_outstanding := 0;
  ELSIF v_action = 'opening' THEN
    IF v_loan.opening_recorded OR coalesce(p_event->>'outstanding_minor', '') !~ '^[1-9][0-9]{0,37}$' THEN
      RAISE EXCEPTION 'Opening balance already recorded or invalid' USING ERRCODE = '23514';
    END IF;
    v_outstanding := (p_event->>'outstanding_minor')::numeric;
    UPDATE public.manual_loans SET opening_recorded = true, outstanding_minor = v_outstanding::text, updated_at = now() WHERE id = v_loan_id;
    INSERT INTO public.manual_loan_events(user_id, loan_id, evidence_id, kind, occurred_on, principal_minor, outstanding_after_minor)
    VALUES(v_user, v_loan_id, v_evidence_id, 'opening', (p_event->>'occurred_on')::date, v_outstanding::text, v_outstanding::text)
    RETURNING id INTO v_id;
  ELSE
    IF NOT v_loan.opening_recorded THEN RAISE EXCEPTION 'Record a sourced opening balance first' USING ERRCODE = '23514'; END IF;
    IF (p_event->>'occurred_on')::date < (
      SELECT max(occurred_on) FROM public.manual_loan_events WHERE loan_id = v_loan_id
    ) THEN
      RAISE EXCEPTION 'Payments must be entered in date order' USING ERRCODE = '23514';
    END IF;
    IF coalesce(p_event->>'cash_paid_minor', '') !~ '^[1-9][0-9]{0,37}$'
      OR coalesce(p_event->>'principal_minor', '') !~ '^(0|[1-9][0-9]{0,37})$'
      OR coalesce(p_event->>'interest_minor', '') !~ '^(0|[1-9][0-9]{0,37})$'
      OR coalesce(p_event->>'insurance_minor', '') !~ '^(0|[1-9][0-9]{0,37})$'
      OR coalesce(p_event->>'fee_minor', '') !~ '^(0|[1-9][0-9]{0,37})$' THEN
      RAISE EXCEPTION 'Payment requires exact sourced allocation' USING ERRCODE = '22023';
    END IF;
    v_paid := (p_event->>'cash_paid_minor')::numeric;
    v_principal := (p_event->>'principal_minor')::numeric;
    v_interest := (p_event->>'interest_minor')::numeric;
    v_insurance := (p_event->>'insurance_minor')::numeric;
    v_fee := (p_event->>'fee_minor')::numeric;
    IF v_paid <> v_principal + v_interest + v_insurance + v_fee
      OR v_principal > v_loan.outstanding_minor::numeric THEN
      RAISE EXCEPTION 'Payment allocation or principal is invalid' USING ERRCODE = '23514';
    END IF;
    v_outstanding := v_loan.outstanding_minor::numeric - v_principal;
    IF length((v_loan.interest_expense_minor::numeric + v_interest)::text) > 38
      OR length((v_loan.insurance_expense_minor::numeric + v_insurance)::text) > 38
      OR length((v_loan.fee_expense_minor::numeric + v_fee)::text) > 38 THEN
      RAISE EXCEPTION 'Loan amount exceeds supported range' USING ERRCODE = '22023';
    END IF;
    UPDATE public.manual_loans SET outstanding_minor = v_outstanding::text,
      interest_expense_minor = (interest_expense_minor::numeric + v_interest)::text,
      insurance_expense_minor = (insurance_expense_minor::numeric + v_insurance)::text,
      fee_expense_minor = (fee_expense_minor::numeric + v_fee)::text,
      updated_at = now() WHERE id = v_loan_id;
    INSERT INTO public.manual_loan_events(user_id, loan_id, evidence_id, kind, occurred_on, cash_paid_minor,
      principal_minor, interest_minor, insurance_minor, fee_minor, outstanding_after_minor)
    VALUES(v_user, v_loan_id, v_evidence_id, 'payment', (p_event->>'occurred_on')::date, v_paid::text,
      v_principal::text, v_interest::text, v_insurance::text, v_fee::text, v_outstanding::text)
    RETURNING id INTO v_id;
  END IF;
  v_result := jsonb_build_object('id', v_id, 'loan_id', v_loan_id, 'outstanding_minor', v_outstanding::text, 'replayed', false);
  INSERT INTO public.manual_loan_requests(user_id, request_id, payload_hash, result)
    VALUES(v_user, p_request_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_loan_event(uuid, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_loan_event(uuid, boolean, jsonb) TO authenticated;
