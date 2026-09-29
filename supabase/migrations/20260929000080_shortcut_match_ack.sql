-- Explicit acknowledgement of an existing transaction; no financial rows are changed.
ALTER TABLE public.shortcut_inbox_items
  DROP CONSTRAINT shortcut_inbox_items_status_check;
ALTER TABLE public.shortcut_inbox_items
  ADD CONSTRAINT shortcut_inbox_items_status_check
  CHECK (status IN ('pending', 'non_transaction', 'dismissed', 'matched'));
ALTER TABLE public.shortcut_inbox_items
  ADD CONSTRAINT shortcut_inbox_items_id_user_unique UNIQUE (id, user_id);

CREATE TABLE public.shortcut_inbox_match_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  inbox_item_id UUID NOT NULL,
  transaction_id UUID NOT NULL,
  transaction_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_match_inbox_owner_fk
    FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_match_transaction_owner_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_match_one_per_inbox UNIQUE (user_id, inbox_item_id)
);
CREATE INDEX shortcut_match_user_created_idx
  ON public.shortcut_inbox_match_decisions (user_id, created_at DESC);
CREATE INDEX shortcut_match_transaction_idx
  ON public.shortcut_inbox_match_decisions (user_id, transaction_id);

CREATE FUNCTION public.reject_shortcut_match_decision_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut match decisions are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_match_decisions_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_inbox_match_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_match_decision_mutation();

CREATE FUNCTION public.guard_shortcut_match_status()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'matched' AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT (current_user = 'postgres'
      AND current_setting('app.shortcut_match_erasure', true) = 'on'
      AND pg_trigger_depth() > 1) THEN
    RAISE EXCEPTION 'Matched inbox status is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'matched' AND OLD.status IS DISTINCT FROM 'matched' AND NOT EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_decisions
    WHERE inbox_item_id = NEW.id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Matched status requires a decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shortcut_match_status_guard
  BEFORE UPDATE ON public.shortcut_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_shortcut_match_status();

-- A hard delete is an erasure exception to the otherwise immutable audit.
-- It removes snapshots and returns surviving inbox items to review.
CREATE FUNCTION public.erase_shortcut_matches_for_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_previous TEXT := current_setting('app.shortcut_match_erasure', true);
BEGIN
  PERFORM set_config('app.shortcut_match_erasure', 'on', true);
  UPDATE public.shortcut_inbox_items SET status = 'pending'
  WHERE user_id = OLD.user_id AND id IN (
    SELECT inbox_item_id FROM public.shortcut_inbox_match_decisions
    WHERE user_id = OLD.user_id AND transaction_id = OLD.id
  );
  DELETE FROM public.shortcut_inbox_match_decisions
  WHERE user_id = OLD.user_id AND transaction_id = OLD.id;
  PERFORM set_config('app.shortcut_match_erasure', COALESCE(v_previous, ''), true);
  RETURN OLD;
END;
$$;
CREATE TRIGGER shortcut_match_transaction_erasure
  BEFORE DELETE ON public.transactions FOR EACH ROW
  EXECUTE FUNCTION public.erase_shortcut_matches_for_transaction();

CREATE FUNCTION public.erase_shortcut_match_for_inbox()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_previous TEXT := current_setting('app.shortcut_match_erasure', true);
BEGIN
  PERFORM set_config('app.shortcut_match_erasure', 'on', true);
  DELETE FROM public.shortcut_inbox_match_decisions
  WHERE user_id = OLD.user_id AND inbox_item_id = OLD.id;
  PERFORM set_config('app.shortcut_match_erasure', COALESCE(v_previous, ''), true);
  RETURN OLD;
END;
$$;
CREATE TRIGGER shortcut_match_inbox_erasure
  BEFORE DELETE ON public.shortcut_inbox_items FOR EACH ROW
  EXECUTE FUNCTION public.erase_shortcut_match_for_inbox();

ALTER TABLE public.shortcut_inbox_match_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_match_select_owner ON public.shortcut_inbox_match_decisions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_inbox_match_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_inbox_match_decisions TO authenticated;
GRANT SELECT ON public.shortcut_inbox_match_decisions TO service_role;

CREATE FUNCTION public.acknowledge_shortcut_match(
  p_inbox_item_id UUID, p_transaction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_inbox RECORD;
  v_transaction RECORD;
  v_existing RECORD;
  v_decision_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_inbox_item_id IS NULL OR p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Inbox item and transaction are required' USING ERRCODE = '22023';
  END IF;

  -- The inbox lock serializes retries and competing choices for this item.
  SELECT id, status INTO v_inbox
  FROM public.shortcut_inbox_items
  WHERE id = p_inbox_item_id AND user_id = v_user
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbox item not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, transaction_id INTO v_existing
  FROM public.shortcut_inbox_match_decisions
  WHERE inbox_item_id = p_inbox_item_id AND user_id = v_user;
  IF FOUND THEN
    IF v_existing.transaction_id = p_transaction_id THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'Inbox item already matched to another transaction' USING ERRCODE = '23505';
  END IF;
  IF v_inbox.status <> 'pending' THEN
    RAISE EXCEPTION 'Inbox item is not pending review' USING ERRCODE = '23514';
  END IF;

  -- FOR SHARE prevents a concurrent soft delete before this decision commits.
  SELECT id, amount, date, description, account_id, type, source
  INTO v_transaction
  FROM public.transactions
  WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active transaction not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.shortcut_inbox_match_decisions (
    user_id, inbox_item_id, transaction_id, transaction_snapshot
  ) VALUES (
    v_user, p_inbox_item_id, p_transaction_id,
    jsonb_build_object('id', v_transaction.id, 'amount', v_transaction.amount,
      'date', v_transaction.date, 'description', v_transaction.description,
      'account_id', v_transaction.account_id, 'type', v_transaction.type,
      'source', v_transaction.source)
  ) RETURNING id INTO v_decision_id;

  UPDATE public.shortcut_inbox_items SET status = 'matched'
  WHERE id = p_inbox_item_id AND user_id = v_user;
  RETURN v_decision_id;
END;
$$;
REVOKE ALL ON FUNCTION public.acknowledge_shortcut_match(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_shortcut_match(UUID, UUID) TO authenticated;
