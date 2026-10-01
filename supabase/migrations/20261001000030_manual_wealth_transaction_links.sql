-- Reviewed references connect a manual journal event to one existing ledger movement.
ALTER TABLE public.investment_trades ADD COLUMN source_transaction_id uuid;
ALTER TABLE public.manual_loan_events ADD COLUMN source_transaction_id uuid;

ALTER TABLE public.investment_trades
  ADD CONSTRAINT investment_trade_source_transaction_fk
  FOREIGN KEY (source_transaction_id, user_id)
  REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (source_transaction_id);
ALTER TABLE public.manual_loan_events
  ADD CONSTRAINT manual_loan_event_source_transaction_fk
  FOREIGN KEY (source_transaction_id, user_id)
  REFERENCES public.transactions(id, user_id) ON DELETE SET NULL (source_transaction_id);

CREATE TABLE public.manual_wealth_link_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_kind text NOT NULL CHECK (event_kind IN ('investment_trade', 'loan_event')),
  event_id uuid NOT NULL,
  old_transaction_id uuid,
  new_transaction_id uuid,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX manual_wealth_link_audit_owner_date_idx
  ON public.manual_wealth_link_audit(user_id, reviewed_at DESC);
ALTER TABLE public.manual_wealth_link_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY manual_wealth_link_audit_owner ON public.manual_wealth_link_audit
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.manual_wealth_link_audit FROM anon, authenticated;
GRANT SELECT ON public.manual_wealth_link_audit TO authenticated;
GRANT ALL ON public.manual_wealth_link_audit TO service_role;

CREATE FUNCTION public.link_manual_wealth_event(
  p_kind text,
  p_event_id uuid,
  p_transaction_id uuid,
  p_reviewed boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_event_kind text;
  v_event_date date;
  v_previous uuid;
  v_transaction public.transactions%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_kind NOT IN ('investment_trade', 'loan_event') OR p_event_id IS NULL
    OR p_reviewed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A reviewed wealth event is required' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'investment_trade' THEN
    SELECT kind, occurred_on, source_transaction_id
    INTO v_event_kind, v_event_date, v_previous
    FROM public.investment_trades
    WHERE id = p_event_id AND user_id = v_user FOR UPDATE;
  ELSE
    SELECT kind, occurred_on, source_transaction_id
    INTO v_event_kind, v_event_date, v_previous
    FROM public.manual_loan_events
    WHERE id = p_event_id AND user_id = v_user FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wealth event not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_previous IS NOT DISTINCT FROM p_transaction_id THEN
    RETURN jsonb_build_object('event_id', p_event_id, 'transaction_id', p_transaction_id,
      'unchanged', true);
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    SELECT * INTO v_transaction FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
    END IF;
    IF abs(v_transaction.date - v_event_date) > 3 THEN
      RAISE EXCEPTION 'Transaction date differs from event date' USING ERRCODE = '23514';
    END IF;
    IF (p_kind = 'investment_trade' AND v_event_kind IN ('opening', 'buy')
      AND v_transaction.type NOT IN ('expense', 'transfer'))
      OR (p_kind = 'investment_trade' AND v_event_kind = 'sell'
      AND v_transaction.type NOT IN ('income', 'transfer'))
      OR (p_kind = 'loan_event' AND v_event_kind = 'opening'
      AND v_transaction.type NOT IN ('income', 'transfer'))
      OR (p_kind = 'loan_event' AND v_event_kind = 'payment'
      AND v_transaction.type NOT IN ('expense', 'transfer')) THEN
      RAISE EXCEPTION 'Transaction direction does not match wealth event'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_kind = 'investment_trade' THEN
    UPDATE public.investment_trades SET source_transaction_id = p_transaction_id
    WHERE id = p_event_id AND user_id = v_user;
  ELSE
    UPDATE public.manual_loan_events SET source_transaction_id = p_transaction_id
    WHERE id = p_event_id AND user_id = v_user;
  END IF;
  INSERT INTO public.manual_wealth_link_audit(
    user_id, event_kind, event_id, old_transaction_id, new_transaction_id
  ) VALUES (v_user, p_kind, p_event_id, v_previous, p_transaction_id);
  RETURN jsonb_build_object('event_id', p_event_id, 'transaction_id', p_transaction_id,
    'unchanged', false);
END;
$$;

REVOKE ALL ON FUNCTION public.link_manual_wealth_event(text, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_manual_wealth_event(text, uuid, uuid, boolean) TO authenticated;

CREATE FUNCTION public.guard_reviewed_wealth_transaction_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.investment_trades WHERE source_transaction_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.manual_loan_events WHERE source_transaction_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Transaction has a reviewed wealth link' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reviewed_wealth_transaction_delete_guard
  BEFORE UPDATE OF deleted_at ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_reviewed_wealth_transaction_delete();
