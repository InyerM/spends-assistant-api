-- Reviewed financial rows may be removed while their immutable review provenance survives.
CREATE TABLE public.transaction_deletion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,user_id),
  FOREIGN KEY(transaction_id,user_id) REFERENCES public.transactions(id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.transaction_deletion_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_deletion_decisions_owner_read ON public.transaction_deletion_decisions
  FOR SELECT TO authenticated USING (user_id=auth.uid());
CREATE POLICY terms_acceptance_required ON public.transaction_deletion_decisions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.has_accepted_required_terms()))
  WITH CHECK ((SELECT public.has_accepted_required_terms()));
CREATE TRIGGER terms_acceptance_before_write BEFORE INSERT OR UPDATE
  ON public.transaction_deletion_decisions FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_terms_before_owner_write();
REVOKE ALL ON public.transaction_deletion_decisions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.transaction_deletion_decisions TO authenticated;
CREATE FUNCTION public.guard_transaction_deletion_decisions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM public.transactions WHERE id=OLD.transaction_id) THEN
    RAISE EXCEPTION 'Transaction deletion decisions are append-only' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER transaction_deletion_decisions_immutable BEFORE UPDATE OR DELETE
  ON public.transaction_deletion_decisions FOR EACH ROW
  EXECUTE FUNCTION public.guard_transaction_deletion_decisions();

-- Run after 20260929000130_manual_transaction_atomic.sql.
-- Soft-delete an owner's transactions and reverse their balances in one transaction.
CREATE OR REPLACE FUNCTION public.soft_delete_transactions(p_transaction_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_account_ids uuid[];
  v_account_id uuid;
  v_tx public.transactions%ROWTYPE;
  v_deleted integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_transaction_ids IS NULL OR cardinality(p_transaction_ids) NOT BETWEEN 1 AND 2000
    OR array_position(p_transaction_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Provide between 1 and 2000 transaction IDs' USING ERRCODE = '22023';
  END IF;

  -- Lock accounts before transactions, as in the manual creation RPC. Recheck
  -- each transaction after locking because another writer may have edited it.
  SELECT array_agg(id ORDER BY id) INTO v_account_ids FROM (
    SELECT account_id AS id FROM public.transactions
      WHERE user_id = v_user AND id = ANY(p_transaction_ids) AND deleted_at IS NULL
    UNION
    SELECT transfer_to_account_id AS id FROM public.transactions
      WHERE user_id = v_user AND id = ANY(p_transaction_ids)
        AND deleted_at IS NULL AND transfer_to_account_id IS NOT NULL
  ) account_ids;
  FOR v_account_id IN SELECT unnest(coalesce(v_account_ids, ARRAY[]::uuid[])) ORDER BY 1 LOOP
    PERFORM 1 FROM public.accounts
      WHERE id = v_account_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction account does not belong to caller'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR v_tx IN SELECT * FROM public.transactions
    WHERE user_id = v_user AND id = ANY(p_transaction_ids) AND deleted_at IS NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF v_account_ids IS NULL OR v_tx.account_id <> ALL(v_account_ids)
      OR (v_tx.transfer_to_account_id IS NOT NULL
        AND v_tx.transfer_to_account_id <> ALL(v_account_ids)) THEN
      RAISE EXCEPTION 'Transaction accounts changed during deletion'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.transaction_deletion_decisions(user_id,transaction_id,before_state)
      VALUES (v_user,v_tx.id,jsonb_build_object(
        'type',v_tx.type,'amount',v_tx.amount,'account_id',v_tx.account_id,
        'transfer_to_account_id',v_tx.transfer_to_account_id));

    UPDATE public.transactions SET deleted_at = now()
      WHERE id = v_tx.id AND user_id = v_user;
    IF v_tx.type = 'expense' THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) + v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
    ELSIF v_tx.type = 'income' THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) - v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
    ELSIF v_tx.type = 'transfer' AND v_tx.transfer_to_account_id IS NOT NULL THEN
      UPDATE public.accounts SET balance = coalesce(balance, 0) + v_tx.amount
        WHERE id = v_tx.account_id AND user_id = v_user;
      UPDATE public.accounts SET balance = coalesce(balance, 0) - v_tx.amount
        WHERE id = v_tx.transfer_to_account_id AND user_id = v_user;
    END IF;
    v_deleted := v_deleted + 1;
  END LOOP;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION public.soft_delete_transactions(uuid[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_transactions(uuid[])
  TO authenticated;
