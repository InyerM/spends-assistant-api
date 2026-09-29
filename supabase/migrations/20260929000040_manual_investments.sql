-- Reviewed manual investment records. These tables are deliberately independent
-- from accounts, transactions, and dashboard balance calculations.
CREATE TABLE public.investment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('manual_review', 'statement', 'broker_report')),
  reference text NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 500),
  observed_on date NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE public.investment_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('tyba', 'binance')),
  symbol text NOT NULL CHECK (length(trim(symbol)) BETWEEN 1 AND 80),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z][A-Z0-9]{2,7}$'),
  quantity_scale integer NOT NULL CHECK (quantity_scale BETWEEN 0 AND 18),
  money_scale integer NOT NULL CHECK (money_scale BETWEEN 0 AND 18),
  quantity_atoms text NOT NULL DEFAULT '0' CHECK (quantity_atoms ~ '^(0|[1-9][0-9]{0,37})$'),
  cost_basis_minor text NOT NULL DEFAULT '0' CHECK (cost_basis_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  realized_return_minor text NOT NULL DEFAULT '0' CHECK (realized_return_minor ~ '^-?(0|[1-9][0-9]{0,37})$'),
  evidence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (evidence_id, user_id) REFERENCES public.investment_evidence(id, user_id)
);
CREATE INDEX investment_positions_user_created_idx ON public.investment_positions(user_id, created_at DESC);
CREATE TRIGGER investment_positions_updated_at BEFORE UPDATE ON public.investment_positions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TABLE public.investment_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opening', 'buy', 'sell')),
  occurred_on date NOT NULL,
  quantity_atoms text NOT NULL CHECK (quantity_atoms ~ '^[1-9][0-9]{0,37}$'),
  gross_minor text NOT NULL CHECK (gross_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  fee_minor text NOT NULL CHECK (fee_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  allocated_basis_minor text NOT NULL DEFAULT '0' CHECK (allocated_basis_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  realized_delta_minor text NOT NULL DEFAULT '0' CHECK (realized_delta_minor ~ '^-?(0|[1-9][0-9]{0,37})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (position_id, user_id) REFERENCES public.investment_positions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, user_id) REFERENCES public.investment_evidence(id, user_id)
);
CREATE INDEX investment_trades_owner_position_date_idx
  ON public.investment_trades(user_id, position_id, occurred_on DESC, created_at DESC);
CREATE UNIQUE INDEX investment_trades_one_opening_idx
  ON public.investment_trades(position_id) WHERE kind = 'opening';

CREATE TABLE public.investment_valuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  as_of date NOT NULL,
  market_value_minor text NOT NULL CHECK (market_value_minor ~ '^(0|[1-9][0-9]{0,37})$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (position_id, user_id) REFERENCES public.investment_positions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id, user_id) REFERENCES public.investment_evidence(id, user_id)
);
CREATE INDEX investment_valuations_owner_position_date_idx
  ON public.investment_valuations(user_id, position_id, as_of DESC, created_at DESC);

CREATE TABLE public.investment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);
CREATE INDEX investment_requests_user_created_idx ON public.investment_requests(user_id, created_at DESC);

ALTER TABLE public.investment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_valuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY investment_evidence_owner ON public.investment_evidence
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY investment_positions_owner ON public.investment_positions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY investment_trades_owner ON public.investment_trades
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY investment_valuations_owner ON public.investment_valuations
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY investment_requests_owner ON public.investment_requests
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY investment_evidence_service ON public.investment_evidence
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY investment_positions_service ON public.investment_positions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY investment_trades_service ON public.investment_trades
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY investment_valuations_service ON public.investment_valuations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY investment_requests_service ON public.investment_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated clients can read their rows. Only the reviewed RPC can write.
REVOKE ALL ON public.investment_evidence, public.investment_positions,
  public.investment_trades, public.investment_valuations, public.investment_requests
  FROM anon, authenticated;
GRANT SELECT ON public.investment_evidence, public.investment_positions,
  public.investment_trades, public.investment_valuations, public.investment_requests
  TO authenticated;
GRANT ALL ON public.investment_evidence, public.investment_positions,
  public.investment_trades, public.investment_valuations, public.investment_requests
  TO service_role;

CREATE FUNCTION public.confirm_investment_event(
  p_request_id uuid, p_reviewed boolean, p_event jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_prior public.investment_requests%ROWTYPE;
  v_evidence_id uuid;
  v_position public.investment_positions%ROWTYPE;
  v_action text;
  v_id uuid;
  v_position_id uuid;
  v_quantity numeric;
  v_gross numeric;
  v_fee numeric;
  v_basis numeric;
  v_allocated numeric := 0;
  v_realized_delta numeric := 0;
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF p_request_id IS NULL OR p_reviewed IS DISTINCT FROM true
    OR jsonb_typeof(p_event) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Explicit review and a request ID are required' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(p_event::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_prior FROM public.investment_requests
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Request ID belongs to another entry' USING ERRCODE = '22023';
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  v_action := p_event->>'action';
  IF coalesce(v_action, '') NOT IN ('create_position', 'opening', 'buy', 'sell', 'valuation')
     OR jsonb_typeof(p_event->'evidence') IS DISTINCT FROM 'object'
     OR coalesce(p_event->'evidence'->>'kind', '') NOT IN ('manual_review', 'statement', 'broker_report')
     OR length(trim(coalesce(p_event->'evidence'->>'reference', ''))) NOT BETWEEN 1 AND 500
     OR coalesce(p_event->'evidence'->>'observed_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid investment entry or evidence' USING ERRCODE = '22023';
  END IF;

  IF v_action = 'create_position' THEN
    IF p_event->>'provider' NOT IN ('tyba', 'binance')
      OR length(trim(coalesce(p_event->>'symbol', ''))) NOT BETWEEN 1 AND 80
      OR coalesce(p_event->>'quote_currency', '') !~ '^[A-Z][A-Z0-9]{2,7}$'
      OR coalesce(p_event->>'quantity_scale', '') !~ '^(0|[1-9]|1[0-8])$'
      OR coalesce(p_event->>'money_scale', '') !~ '^(0|[1-9]|1[0-8])$' THEN
      RAISE EXCEPTION 'Invalid position metadata' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_position_id := (p_event->>'position_id')::uuid;
    SELECT * INTO v_position FROM public.investment_positions
      WHERE id = v_position_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Position not found' USING ERRCODE = '42501'; END IF;
  END IF;

  INSERT INTO public.investment_evidence(user_id, kind, reference, observed_on)
    VALUES(v_user, p_event->'evidence'->>'kind',
      trim(p_event->'evidence'->>'reference'), (p_event->'evidence'->>'observed_on')::date)
    RETURNING id INTO v_evidence_id;

  IF v_action = 'create_position' THEN
    INSERT INTO public.investment_positions(user_id, provider, symbol, quote_currency,
      quantity_scale, money_scale, evidence_id)
    VALUES(v_user, p_event->>'provider', trim(p_event->>'symbol'),
      p_event->>'quote_currency', (p_event->>'quantity_scale')::integer,
      (p_event->>'money_scale')::integer, v_evidence_id)
    RETURNING id INTO v_position_id;
    v_id := v_position_id;
  ELSIF v_action = 'valuation' THEN
    IF coalesce(p_event->>'as_of', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR coalesce(p_event->>'market_value_minor', '') !~ '^(0|[1-9][0-9]{0,37})$' THEN
      RAISE EXCEPTION 'Invalid dated valuation' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.investment_valuations(user_id, position_id, evidence_id, as_of,
      market_value_minor)
    VALUES(v_user, v_position_id, v_evidence_id, (p_event->>'as_of')::date,
      p_event->>'market_value_minor')
    RETURNING id INTO v_id;
  ELSE
    IF coalesce(p_event->>'occurred_on', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR coalesce(p_event->>'quantity_atoms', '') !~ '^[1-9][0-9]{0,37}$' THEN
      RAISE EXCEPTION 'Invalid trade date or quantity' USING ERRCODE = '22023';
    END IF;
    v_quantity := (p_event->>'quantity_atoms')::numeric;
    IF v_action = 'opening' THEN
      IF EXISTS (SELECT 1 FROM public.investment_trades WHERE position_id = v_position_id)
        OR v_position.quantity_atoms <> '0' THEN
        RAISE EXCEPTION 'Opening lot already recorded' USING ERRCODE = '23514';
      END IF;
      IF coalesce(p_event->>'cost_basis_minor', '') !~ '^(0|[1-9][0-9]{0,37})$' THEN
        RAISE EXCEPTION 'Invalid opening cost basis' USING ERRCODE = '22023';
      END IF;
      IF p_event->>'cost_basis_minor' = '0'
         AND coalesce(p_event->>'known_zero_basis', '') <> 'true' THEN
        RAISE EXCEPTION 'Known zero opening basis requires acknowledgement' USING ERRCODE = '22023';
      END IF;
      v_gross := (p_event->>'cost_basis_minor')::numeric;
      v_fee := 0;
      v_basis := v_gross;
    ELSE
      IF coalesce(p_event->>'gross_minor', '') !~ '^[1-9][0-9]{0,37}$'
         OR coalesce(p_event->>'fee_minor', '') !~ '^(0|[1-9][0-9]{0,37})$' THEN
        RAISE EXCEPTION 'Invalid trade gross or fee' USING ERRCODE = '22023';
      END IF;
      v_gross := (p_event->>'gross_minor')::numeric;
      v_fee := (p_event->>'fee_minor')::numeric;
      IF v_action = 'buy' THEN
        v_basis := (v_position.cost_basis_minor)::numeric + v_gross + v_fee;
      ELSE
        IF v_quantity > (v_position.quantity_atoms)::numeric THEN
          RAISE EXCEPTION 'Insufficient position quantity' USING ERRCODE = '23514';
        END IF;
        v_allocated := CASE WHEN v_quantity = (v_position.quantity_atoms)::numeric
          THEN (v_position.cost_basis_minor)::numeric
          ELSE round((v_position.cost_basis_minor)::numeric * v_quantity /
            (v_position.quantity_atoms)::numeric, 0) END;
        v_basis := (v_position.cost_basis_minor)::numeric - v_allocated;
        v_realized_delta := v_gross - v_fee - v_allocated;
      END IF;
    END IF;
    INSERT INTO public.investment_trades(user_id, position_id, evidence_id, kind, occurred_on,
      quantity_atoms, gross_minor, fee_minor, allocated_basis_minor, realized_delta_minor)
    VALUES(v_user, v_position_id, v_evidence_id, v_action,
      (p_event->>'occurred_on')::date, v_quantity::text, v_gross::text, v_fee::text,
      v_allocated::text, v_realized_delta::text)
    RETURNING id INTO v_id;
    UPDATE public.investment_positions SET
      quantity_atoms = CASE WHEN v_action = 'sell'
        THEN ((v_position.quantity_atoms)::numeric - v_quantity)::text
        ELSE ((v_position.quantity_atoms)::numeric + v_quantity)::text END,
      cost_basis_minor = v_basis::text,
      realized_return_minor = ((v_position.realized_return_minor)::numeric + v_realized_delta)::text
    WHERE id = v_position_id AND user_id = v_user;
  END IF;

  SELECT jsonb_build_object('id', v_id, 'position_id', v_position_id,
    'action', v_action, 'quantity_atoms', quantity_atoms,
    'cost_basis_minor', cost_basis_minor, 'realized_return_minor', realized_return_minor,
    'replayed', false) INTO v_result
    FROM public.investment_positions WHERE id = v_position_id AND user_id = v_user;
  INSERT INTO public.investment_requests(user_id, request_id, payload_hash, result)
    VALUES(v_user, p_request_id, v_hash, v_result);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_investment_event(uuid, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_investment_event(uuid, boolean, jsonb) TO authenticated;
