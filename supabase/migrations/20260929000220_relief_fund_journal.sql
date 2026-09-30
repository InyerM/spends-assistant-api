-- Reviewed, append-only earmarked fund journal. It never writes bank balances,
-- transactions, categories, usage counters, or personal spending reports.
CREATE TABLE public.relief_funds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 500),
  currency text NOT NULL CHECK (currency = 'COP'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX relief_funds_owner_created_idx ON public.relief_funds(user_id, created_at DESC);

CREATE TABLE public.relief_fund_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fund_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'outlay', 'unknown_spend')),
  occurred_on date,
  amount_minor text CHECK (amount_minor IS NULL OR amount_minor ~ '^[1-9][0-9]{0,35}$'),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  source_kind text NOT NULL CHECK (source_kind IN
    ('ledger_transaction', 'bank_notice', 'cash', 'receipt', 'manual_recollection')),
  source_reference text NOT NULL CHECK (length(btrim(source_reference)) BETWEEN 1 AND 500),
  transaction_id uuid,
  transaction_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fund_id, user_id) REFERENCES public.relief_funds(id, user_id),
  CHECK ((kind = 'unknown_spend' AND amount_minor IS NULL AND transaction_id IS NULL)
    OR (kind IN ('receipt', 'outlay') AND amount_minor IS NOT NULL)),
  CHECK (kind = 'unknown_spend' OR occurred_on IS NOT NULL),
  CHECK ((source_kind = 'ledger_transaction' AND transaction_id IS NOT NULL
      AND transaction_snapshot IS NOT NULL)
    OR (source_kind <> 'ledger_transaction' AND transaction_id IS NULL
      AND transaction_snapshot IS NULL))
);
CREATE INDEX relief_fund_entries_owner_fund_date_idx
  ON public.relief_fund_entries(user_id, fund_id, occurred_on DESC, created_at DESC);
-- A ledger movement can fund exactly one journal entry across all funds.
CREATE UNIQUE INDEX relief_fund_entries_unique_transaction_idx
  ON public.relief_fund_entries(user_id, transaction_id) WHERE transaction_id IS NOT NULL;

CREATE FUNCTION public.reject_relief_fund_entry_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Relief fund entries are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER relief_fund_entry_immutable
  BEFORE UPDATE ON public.relief_fund_entries
  FOR EACH ROW EXECUTE FUNCTION public.reject_relief_fund_entry_update();

CREATE TABLE public.relief_fund_requests (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.relief_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relief_fund_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relief_fund_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY relief_funds_owner_select ON public.relief_funds
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY relief_entries_owner_select ON public.relief_fund_entries
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY relief_requests_owner_select ON public.relief_fund_requests
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.relief_funds, public.relief_fund_entries, public.relief_fund_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.relief_funds, public.relief_fund_entries, public.relief_fund_requests
  TO authenticated;
GRANT ALL ON public.relief_funds, public.relief_fund_entries, public.relief_fund_requests
  TO service_role;

CREATE FUNCTION public.confirm_relief_fund_event(
  p_request_id uuid, p_reviewed boolean, p_event jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_prior public.relief_fund_requests%ROWTYPE;
  v_fund public.relief_funds%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_fund_id uuid;
  v_id uuid;
  v_action text;
  v_kind text;
  v_source_kind text;
  v_transaction_id uuid;
  v_amount numeric;
  v_date date;
  v_expected_type text;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_request_id IS NULL OR p_reviewed IS DISTINCT FROM true
    OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Explicit review and request ID required' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(p_event::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('relief:' || v_user::text, 0));
  SELECT * INTO v_prior FROM public.relief_fund_requests
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Request ID belongs to another entry' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  v_action := p_event->>'action';
  IF v_action = 'create_fund' THEN
    IF length(btrim(coalesce(p_event->>'title', ''))) NOT BETWEEN 1 AND 120
      OR length(btrim(coalesce(p_event->>'purpose', ''))) NOT BETWEEN 1 AND 500
      OR p_event->>'currency' IS DISTINCT FROM 'COP' THEN
      RAISE EXCEPTION 'Invalid relief fund' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.relief_funds(user_id, title, purpose, currency)
    VALUES (v_user, btrim(p_event->>'title'), btrim(p_event->>'purpose'), 'COP')
    RETURNING id INTO v_fund_id;
    v_result := jsonb_build_object('fund_id', v_fund_id, 'replayed', false);
  ELSIF v_action = 'add_entry' THEN
    IF coalesce(p_event->>'fund_id','') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'Invalid fund ID' USING ERRCODE = '22023';
    END IF;
    v_fund_id := (p_event->>'fund_id')::uuid;
    SELECT * INTO v_fund FROM public.relief_funds
      WHERE id = v_fund_id AND user_id = v_user;
    IF NOT FOUND THEN RAISE EXCEPTION 'Fund not found' USING ERRCODE = '42501'; END IF;
    v_kind := p_event->>'kind';
    v_source_kind := p_event->>'source_kind';
    IF coalesce(v_kind,'') NOT IN ('receipt','outlay','unknown_spend')
      OR coalesce(v_source_kind,'') NOT IN
        ('ledger_transaction','bank_notice','cash','receipt','manual_recollection')
      OR length(btrim(coalesce(p_event->>'description',''))) NOT BETWEEN 1 AND 500
      OR length(btrim(coalesce(p_event->>'source_reference',''))) NOT BETWEEN 1 AND 500
      OR (v_kind <> 'unknown_spend' AND p_event->>'occurred_on' IS NULL)
      OR (p_event->>'occurred_on' IS NOT NULL
        AND p_event->>'occurred_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN
      RAISE EXCEPTION 'Invalid relief fund entry' USING ERRCODE = '22023';
    END IF;
    IF p_event->>'occurred_on' IS NOT NULL THEN
      v_date := (p_event->>'occurred_on')::date;
      IF to_char(v_date,'YYYY-MM-DD') <> p_event->>'occurred_on' THEN
        RAISE EXCEPTION 'Invalid entry date' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_kind = 'unknown_spend' THEN
      IF p_event->>'amount_minor' IS NOT NULL OR p_event->>'transaction_id' IS NOT NULL
        OR v_source_kind = 'ledger_transaction' THEN
        RAISE EXCEPTION 'Unknown spending cannot carry an invented amount or transaction'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      IF coalesce(p_event->>'amount_minor','') !~ '^[1-9][0-9]{0,35}$' THEN
        RAISE EXCEPTION 'Exact positive amount required' USING ERRCODE = '22023';
      END IF;
      v_amount := (p_event->>'amount_minor')::numeric;
    END IF;
    IF v_source_kind = 'ledger_transaction' THEN
      IF coalesce(p_event->>'transaction_id','') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR v_kind = 'unknown_spend' THEN
        RAISE EXCEPTION 'Reviewed transaction link required' USING ERRCODE = '22023';
      END IF;
      v_transaction_id := (p_event->>'transaction_id')::uuid;
      SELECT * INTO v_tx FROM public.transactions
        WHERE id = v_transaction_id AND user_id = v_user AND deleted_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction owner, direction, or exact amount does not match'
          USING ERRCODE = '22023';
      END IF;
      v_expected_type := CASE WHEN v_kind = 'receipt' THEN 'income' ELSE 'expense' END;
      IF v_tx.type <> v_expected_type OR v_tx.amount * 100 <> v_amount THEN
        RAISE EXCEPTION 'Transaction owner, direction, or exact amount does not match'
          USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.relief_fund_entries
        WHERE user_id = v_user AND transaction_id = v_transaction_id) THEN
        RAISE EXCEPTION 'Transaction is already linked to a relief fund entry'
          USING ERRCODE = '23505';
      END IF;
    ELSIF p_event->>'transaction_id' IS NOT NULL THEN
      RAISE EXCEPTION 'Transaction links require ledger_transaction source'
        USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.relief_fund_entries(
      user_id, fund_id, kind, occurred_on, amount_minor, description,
      source_kind, source_reference, transaction_id, transaction_snapshot
    ) VALUES (
      v_user, v_fund_id, v_kind, v_date,
      CASE WHEN v_kind = 'unknown_spend' THEN NULL ELSE p_event->>'amount_minor' END,
      btrim(p_event->>'description'), v_source_kind, btrim(p_event->>'source_reference'),
      v_transaction_id,
      CASE WHEN v_transaction_id IS NULL THEN NULL
        ELSE jsonb_build_object('id', v_tx.id, 'type', v_tx.type, 'amount', v_tx.amount,
          'deleted_at', v_tx.deleted_at) END
    ) RETURNING id INTO v_id;
    v_result := jsonb_build_object('fund_id', v_fund_id, 'entry_id', v_id, 'replayed', false);
  ELSE
    RAISE EXCEPTION 'Invalid relief fund action' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.relief_fund_requests(user_id, request_id, payload_hash, result)
    VALUES(v_user, p_request_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_relief_fund_event(uuid,boolean,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_relief_fund_event(uuid,boolean,jsonb)
  TO authenticated;
