-- Keep reviewed events immutable while allowing owner-scoped metadata corrections.
ALTER TABLE public.investment_positions ADD COLUMN archived_at timestamptz;
ALTER TABLE public.manual_loans ADD COLUMN archived_at timestamptz;

CREATE FUNCTION public.manage_manual_wealth_record(
  p_kind text,
  p_id uuid,
  p_action text,
  p_label text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_kind NOT IN ('investment', 'loan') OR p_action NOT IN
    ('rename', 'archive', 'restore', 'delete_empty') OR p_id IS NULL THEN
    RAISE EXCEPTION 'Invalid wealth record action' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'investment' THEN
    SELECT id INTO v_id FROM public.investment_positions
    WHERE id = p_id AND user_id = v_user FOR UPDATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Investment position not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_action = 'rename' THEN
      IF p_label IS NULL OR length(trim(p_label)) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'Invalid position name' USING ERRCODE = '22023';
      END IF;
      UPDATE public.investment_positions SET symbol = trim(p_label), updated_at = now()
      WHERE id = p_id AND user_id = v_user;
    ELSIF p_action = 'archive' THEN
      UPDATE public.investment_positions SET archived_at = coalesce(archived_at, now()),
        updated_at = now() WHERE id = p_id AND user_id = v_user;
    ELSIF p_action = 'restore' THEN
      UPDATE public.investment_positions SET archived_at = NULL, updated_at = now()
      WHERE id = p_id AND user_id = v_user;
    ELSE
      IF EXISTS (SELECT 1 FROM public.investment_trades WHERE position_id = p_id)
        OR EXISTS (SELECT 1 FROM public.investment_valuations WHERE position_id = p_id) THEN
        RAISE EXCEPTION 'Investment record has events' USING ERRCODE = '23514';
      END IF;
      DELETE FROM public.investment_positions WHERE id = p_id AND user_id = v_user;
    END IF;
  ELSE
    SELECT id INTO v_id FROM public.manual_loans
    WHERE id = p_id AND user_id = v_user FOR UPDATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Loan not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_action = 'rename' THEN
      IF p_label IS NULL OR length(trim(p_label)) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Invalid loan name' USING ERRCODE = '22023';
      END IF;
      UPDATE public.manual_loans SET label = trim(p_label), updated_at = now()
      WHERE id = p_id AND user_id = v_user;
    ELSIF p_action = 'archive' THEN
      UPDATE public.manual_loans SET archived_at = coalesce(archived_at, now()),
        updated_at = now() WHERE id = p_id AND user_id = v_user;
    ELSIF p_action = 'restore' THEN
      UPDATE public.manual_loans SET archived_at = NULL, updated_at = now()
      WHERE id = p_id AND user_id = v_user;
    ELSE
      IF EXISTS (SELECT 1 FROM public.manual_loan_events WHERE loan_id = p_id) THEN
        RAISE EXCEPTION 'Loan record has events' USING ERRCODE = '23514';
      END IF;
      DELETE FROM public.manual_loans WHERE id = p_id AND user_id = v_user;
    END IF;
  END IF;

  RETURN jsonb_build_object('id', p_id, 'kind', p_kind, 'action', p_action);
END;
$$;

REVOKE ALL ON FUNCTION public.manage_manual_wealth_record(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_manual_wealth_record(text, uuid, text, text) TO authenticated;

CREATE FUNCTION public.require_active_manual_wealth_parent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_archived_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'manual_loan_events' THEN
    SELECT archived_at INTO v_archived_at FROM public.manual_loans WHERE id = NEW.loan_id;
  ELSE
    SELECT archived_at INTO v_archived_at FROM public.investment_positions WHERE id = NEW.position_id;
  END IF;
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived wealth record cannot receive new events' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER investment_trade_active_parent BEFORE INSERT ON public.investment_trades
  FOR EACH ROW EXECUTE FUNCTION public.require_active_manual_wealth_parent();
CREATE TRIGGER investment_valuation_active_parent BEFORE INSERT ON public.investment_valuations
  FOR EACH ROW EXECUTE FUNCTION public.require_active_manual_wealth_parent();
CREATE TRIGGER manual_loan_event_active_parent BEFORE INSERT ON public.manual_loan_events
  FOR EACH ROW EXECUTE FUNCTION public.require_active_manual_wealth_parent();
