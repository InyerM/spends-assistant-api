-- Lulo email notices may be reviewed or matched, but cannot create ledger rows.
-- A rejected decision aborts the whole confirm_shortcut_transaction statement,
-- including its earlier transaction insert, balance adjustment, and quota update.
CREATE FUNCTION public.reject_lulo_shortcut_created_decision()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.decision_type = 'created' AND EXISTS (
    SELECT 1 FROM public.shortcut_inbox_items AS inbox
    WHERE inbox.id = NEW.inbox_item_id
      AND inbox.user_id = NEW.user_id
      AND inbox.source = 'lulo-email-backfill'
  ) THEN
    RAISE EXCEPTION 'Lulo email notices cannot create Shortcut transactions'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_lulo_shortcut_created_decision() FROM PUBLIC;

CREATE TRIGGER shortcut_lulo_created_decision_guard
  BEFORE INSERT ON public.shortcut_inbox_match_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_lulo_shortcut_created_decision();
