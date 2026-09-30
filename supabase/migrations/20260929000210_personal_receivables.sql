-- Reviewed loans made to other people. Existing bank transactions remain the cash ledger.
CREATE TABLE public.personal_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  borrower text NOT NULL CHECK (length(trim(borrower)) BETWEEN 1 AND 120),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  money_scale integer NOT NULL CHECK (money_scale BETWEEN 0 AND 2),
  outstanding_minor text NOT NULL DEFAULT '0' CHECK (outstanding_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX personal_receivables_owner_created_idx
  ON public.personal_receivables(user_id, created_at DESC);

CREATE TABLE public.personal_receivable_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receivable_id uuid NOT NULL,
  source_transaction_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('disbursement', 'repayment')),
  occurred_on date NOT NULL,
  amount_minor text NOT NULL CHECK (amount_minor ~ '^[1-9][0-9]{0,37}$'),
  outstanding_after_minor text NOT NULL CHECK (outstanding_after_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  evidence_reference text NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (receivable_id, user_id) REFERENCES public.personal_receivables(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (source_transaction_id, user_id) REFERENCES public.transactions(id, user_id),
  UNIQUE (user_id, source_transaction_id)
);
CREATE INDEX personal_receivable_events_owner_date_idx
  ON public.personal_receivable_events(user_id, receivable_id, occurred_on DESC, created_at DESC);

CREATE TABLE public.personal_receivable_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);

ALTER TABLE public.personal_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_receivable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_receivable_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY personal_receivables_owner ON public.personal_receivables
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY personal_receivable_events_owner ON public.personal_receivable_events
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY personal_receivable_requests_owner ON public.personal_receivable_requests
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY personal_receivables_service ON public.personal_receivables
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY personal_receivable_events_service ON public.personal_receivable_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY personal_receivable_requests_service ON public.personal_receivable_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.personal_receivables, public.personal_receivable_events,
  public.personal_receivable_requests FROM anon, authenticated;
GRANT SELECT ON public.personal_receivables, public.personal_receivable_events,
  public.personal_receivable_requests TO authenticated;
GRANT ALL ON public.personal_receivables, public.personal_receivable_events,
  public.personal_receivable_requests TO service_role;

CREATE FUNCTION public.confirm_receivable_event(p_request_id uuid, p_reviewed boolean, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_prior public.personal_receivable_requests%ROWTYPE;
  v_receivable public.personal_receivables%ROWTYPE;
  v_transaction record;
  v_action text;
  v_receivable_id uuid;
  v_transaction_id uuid;
  v_event_id uuid;
  v_amount numeric;
  v_outstanding numeric;
  v_date date;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_request_id IS NULL OR p_reviewed IS DISTINCT FROM true
    OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Explicit review and request ID required' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(p_event::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_prior FROM public.personal_receivable_requests
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Request ID belongs to another entry' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  v_action := p_event->>'action';
  IF v_action = 'create_receivable' THEN
    IF length(trim(coalesce(p_event->>'borrower', ''))) NOT BETWEEN 1 AND 120
      OR length(trim(coalesce(p_event->>'label', ''))) NOT BETWEEN 1 AND 120
      OR coalesce(p_event->>'currency', '') !~ '^[A-Z]{3}$'
      OR coalesce(p_event->>'money_scale', '') !~ '^[0-2]$' THEN
      RAISE EXCEPTION 'Invalid receivable details' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.personal_receivables(user_id, borrower, label, currency, money_scale)
      VALUES(v_user, trim(p_event->>'borrower'), trim(p_event->>'label'),
        p_event->>'currency', (p_event->>'money_scale')::integer)
      RETURNING id INTO v_receivable_id;
    v_event_id := v_receivable_id;
    v_outstanding := 0;
  ELSIF v_action IN ('disbursement', 'repayment') THEN
    IF coalesce(p_event->>'receivable_id', '') !~ '^[0-9a-fA-F-]{36}$'
      OR coalesce(p_event->>'source_transaction_id', '') !~ '^[0-9a-fA-F-]{36}$'
      OR coalesce(p_event->>'occurred_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR coalesce(p_event->>'amount_minor', '') !~ '^[1-9][0-9]{0,37}$'
      OR length(trim(coalesce(p_event->>'evidence_reference', ''))) NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'A dated amount and transaction evidence are required' USING ERRCODE = '22023';
    END IF;
    v_receivable_id := (p_event->>'receivable_id')::uuid;
    v_transaction_id := (p_event->>'source_transaction_id')::uuid;
    v_date := (p_event->>'occurred_on')::date;
    v_amount := (p_event->>'amount_minor')::numeric;
    SELECT * INTO v_receivable FROM public.personal_receivables
      WHERE id = v_receivable_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receivable not found' USING ERRCODE = '42501'; END IF;
    IF v_date < (SELECT max(occurred_on) FROM public.personal_receivable_events
      WHERE receivable_id = v_receivable_id) THEN
      RAISE EXCEPTION 'Events must be entered in date order' USING ERRCODE = '23514';
    END IF;
    SELECT t.id, t.amount, t.date, t.type, a.currency INTO v_transaction
      FROM public.transactions t JOIN public.accounts a ON a.id = t.account_id AND a.user_id = v_user
      WHERE t.id = v_transaction_id AND t.user_id = v_user AND t.deleted_at IS NULL
      FOR SHARE OF t;
    IF NOT FOUND OR v_transaction.date <> v_date
      OR v_transaction.currency <> v_receivable.currency
      OR v_transaction.amount * power(10::numeric, v_receivable.money_scale) <> v_amount
      OR (v_action = 'disbursement' AND v_transaction.type <> 'expense')
      OR (v_action = 'repayment' AND v_transaction.type <> 'income') THEN
      RAISE EXCEPTION 'Source transaction does not match this principal event' USING ERRCODE = '23514';
    END IF;
    IF v_action = 'repayment' AND v_amount > v_receivable.outstanding_minor::numeric THEN
      RAISE EXCEPTION 'Repayment exceeds outstanding principal' USING ERRCODE = '23514';
    END IF;
    v_outstanding := v_receivable.outstanding_minor::numeric +
      CASE WHEN v_action = 'disbursement' THEN v_amount ELSE -v_amount END;
    IF length(v_outstanding::text) > 38 THEN
      RAISE EXCEPTION 'Principal exceeds supported range' USING ERRCODE = '22023';
    END IF;
    UPDATE public.personal_receivables SET outstanding_minor = v_outstanding::text,
      updated_at = now() WHERE id = v_receivable_id;
    INSERT INTO public.personal_receivable_events(user_id, receivable_id, source_transaction_id,
      kind, occurred_on, amount_minor, outstanding_after_minor, evidence_reference)
      VALUES(v_user, v_receivable_id, v_transaction_id, v_action, v_date, v_amount::text,
        v_outstanding::text, trim(p_event->>'evidence_reference'))
      RETURNING id INTO v_event_id;
  ELSE
    RAISE EXCEPTION 'Invalid receivable action' USING ERRCODE = '22023';
  END IF;
  v_result := jsonb_build_object('id', v_event_id, 'receivable_id', v_receivable_id,
    'outstanding_minor', v_outstanding::text, 'replayed', false);
  INSERT INTO public.personal_receivable_requests(user_id, request_id, payload_hash, result)
    VALUES(v_user, p_request_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_receivable_event(uuid, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_receivable_event(uuid, boolean, jsonb) TO authenticated;

-- A reviewed principal event cannot silently lose its bank evidence. Ordinary
-- descriptions and notes remain editable; changing money/date/direction first
-- requires an explicit receivable reversal workflow in a later release.
CREATE FUNCTION public.guard_linked_receivable_source()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.amount, NEW.date, NEW.type, NEW.account_id, NEW.user_id, NEW.deleted_at)
    IS NOT DISTINCT FROM
    (OLD.amount, OLD.date, OLD.type, OLD.account_id, OLD.user_id, OLD.deleted_at) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.personal_receivable_events
    WHERE source_transaction_id = OLD.id AND user_id = OLD.user_id) THEN
    RAISE EXCEPTION 'Transaction is linked to a reviewed receivable event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_linked_receivable_source
  BEFORE UPDATE OF amount, date, type, account_id, user_id, deleted_at
  ON public.transactions FOR EACH ROW
  EXECUTE FUNCTION public.guard_linked_receivable_source();

-- Hard deletion is a privacy erasure, not an ordinary financial edit. Erase
-- the whole affected receivable and its request receipts before its source
-- transaction is removed, so no misleading partial principal remains.
CREATE FUNCTION public.erase_receivable_for_source_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.personal_receivable_requests requests
    USING public.personal_receivable_events events
    WHERE events.source_transaction_id = OLD.id AND events.user_id = OLD.user_id
      AND requests.user_id = OLD.user_id
      AND requests.result->>'receivable_id' = events.receivable_id::text;
  DELETE FROM public.personal_receivables receivables
    WHERE receivables.user_id = OLD.user_id AND receivables.id IN (
      SELECT receivable_id FROM public.personal_receivable_events
        WHERE source_transaction_id = OLD.id AND user_id = OLD.user_id
    );
  RETURN OLD;
END;
$$;
CREATE TRIGGER erase_receivable_for_source_delete
  BEFORE DELETE ON public.transactions FOR EACH ROW
  EXECUTE FUNCTION public.erase_receivable_for_source_delete();
