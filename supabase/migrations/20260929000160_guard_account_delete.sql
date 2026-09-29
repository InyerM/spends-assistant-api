-- Run after 20260929000150. Preserve active transaction history when removing accounts.
-- Mobile sync and web routes use soft deletion. Hard deletion would bypass the
-- account guard and may cascade through financial or reviewed records.
REVOKE DELETE ON public.accounts, public.transactions FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.soft_delete_empty_account(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_account public.accounts%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'Account ID is required' USING ERRCODE = '22023';
  END IF;

  -- Transaction writes lock referenced accounts, so this check and update
  -- cannot race an active transaction insert or destination assignment.
  SELECT * INTO v_account FROM public.accounts
    WHERE id = p_account_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_account.deleted_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF v_account.is_default THEN
    RAISE EXCEPTION 'Default account cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.transactions
    WHERE deleted_at IS NULL
      AND (account_id = p_account_id OR transfer_to_account_id = p_account_id)
  ) THEN
    RAISE EXCEPTION 'Account has active transactions' USING ERRCODE = '23514';
  END IF;

  UPDATE public.accounts SET deleted_at = now()
    WHERE id = p_account_id AND user_id = v_user AND deleted_at IS NULL;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.soft_delete_empty_account(uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_empty_account(uuid)
  TO authenticated;

-- Apply the same invariant to older clients that still update accounts directly.
CREATE FUNCTION public.guard_account_soft_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF OLD.is_default THEN
      RAISE EXCEPTION 'Default account cannot be deleted' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.transactions
      WHERE deleted_at IS NULL
        AND (account_id = OLD.id OR transfer_to_account_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'Account has active transactions' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_account_soft_delete
  BEFORE UPDATE OF deleted_at ON public.accounts FOR EACH ROW
  EXECUTE FUNCTION public.guard_account_soft_delete();

-- Legacy clients may write transactions directly. Lock and validate account
-- references on those writes too, including transfer destinations.
CREATE FUNCTION public.guard_active_transaction_accounts()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  FOR v_account_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[NEW.account_id, NEW.transfer_to_account_id]) AS refs(id)
      WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM 1 FROM public.accounts
      WHERE id = v_account_id AND user_id = NEW.user_id
        AND is_active AND deleted_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction requires an active account owned by its user'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_active_transaction_accounts
  BEFORE INSERT OR UPDATE OF account_id, transfer_to_account_id, deleted_at, user_id
  ON public.transactions FOR EACH ROW
  EXECUTE FUNCTION public.guard_active_transaction_accounts();
