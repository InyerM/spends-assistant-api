-- Owner corrections preserve reviewed document and Shortcut links and immutable financial evidence.
CREATE TABLE public.transaction_review_metadata_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (transaction_id,user_id) REFERENCES public.transactions(id,user_id) ON DELETE CASCADE
);
ALTER TABLE public.transaction_review_metadata_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY transaction_review_metadata_edits_owner_read
  ON public.transaction_review_metadata_edits FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY terms_acceptance_required ON public.transaction_review_metadata_edits
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.has_accepted_required_terms()))
  WITH CHECK ((SELECT public.has_accepted_required_terms()));
CREATE TRIGGER terms_acceptance_before_write BEFORE INSERT OR UPDATE
  ON public.transaction_review_metadata_edits FOR EACH STATEMENT
  EXECUTE FUNCTION public.enforce_terms_before_owner_write();
REVOKE ALL ON public.transaction_review_metadata_edits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.transaction_review_metadata_edits TO authenticated;
CREATE FUNCTION public.guard_transaction_review_metadata_edits()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM public.transactions WHERE id = OLD.transaction_id) THEN
    RAISE EXCEPTION 'Reviewed transaction metadata edits are append-only' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER transaction_review_metadata_edits_immutable
  BEFORE UPDATE OR DELETE ON public.transaction_review_metadata_edits
  FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_review_metadata_edits();

-- Owner-scoped atomic edits for reviewed transactions.
-- Keep the transaction ID stable while moving every balance change in one SQL transaction.
CREATE OR REPLACE FUNCTION public.patch_reviewed_transaction(
  p_transaction_id uuid, p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_new public.transactions%ROWTYPE;
  v_date date;
  v_time time;
  v_amount numeric(15,2);
  v_type text;
  v_account uuid;
  v_to_account uuid;
  v_category uuid;
  v_description text;
  v_notes text;
  v_payment_method text;
  v_lock_account uuid;
  v_financial_change boolean;
  v_reviewed boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  IF p_transaction_id IS NULL OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object'
    OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'A transaction and nonempty patch are required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) AS key
    WHERE key NOT IN ('date','time','amount','description','notes','category_id',
      'account_id','type','payment_method','transfer_to_account_id')) THEN
    RAISE EXCEPTION 'Unsupported transaction patch field' USING ERRCODE = '22023';
  END IF;
  IF (p_patch ? 'date' AND (jsonb_typeof(p_patch->'date') <> 'string'
      OR coalesce(p_patch->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    OR (p_patch ? 'time' AND (jsonb_typeof(p_patch->'time') <> 'string'
      OR coalesce(p_patch->>'time','') !~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$'))
    OR (p_patch ? 'amount' AND jsonb_typeof(p_patch->'amount') <> 'number')
    OR (p_patch ? 'description' AND jsonb_typeof(p_patch->'description') <> 'string')
    OR (p_patch ? 'notes' AND jsonb_typeof(p_patch->'notes') NOT IN ('string','null'))
    OR (p_patch ? 'account_id' AND jsonb_typeof(p_patch->'account_id') <> 'string')
    OR (p_patch ? 'type' AND jsonb_typeof(p_patch->'type') <> 'string')
    OR (p_patch ? 'category_id' AND jsonb_typeof(p_patch->'category_id') NOT IN ('string','null'))
    OR (p_patch ? 'transfer_to_account_id'
      AND jsonb_typeof(p_patch->'transfer_to_account_id') NOT IN ('string','null'))
    OR (p_patch ? 'payment_method'
      AND jsonb_typeof(p_patch->'payment_method') NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'Invalid transaction patch fields' USING ERRCODE = '22023';
  END IF;

  -- Share the owner lock with manual create/replacement, then lock accounts in
  -- UUID order before the transaction row to avoid opposing financial lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_old FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;

  v_date := CASE WHEN p_patch ? 'date' THEN (p_patch->>'date')::date ELSE v_old.date END;
  v_time := CASE WHEN p_patch ? 'time' THEN (p_patch->>'time')::time ELSE v_old.time END;
  v_amount := CASE WHEN p_patch ? 'amount' THEN (p_patch->>'amount')::numeric(15,2)
    ELSE v_old.amount END;
  v_type := CASE WHEN p_patch ? 'type' THEN p_patch->>'type' ELSE v_old.type END;
  v_account := CASE WHEN p_patch ? 'account_id' THEN (p_patch->>'account_id')::uuid
    ELSE v_old.account_id END;
  v_to_account := CASE WHEN p_patch ? 'transfer_to_account_id'
    THEN (p_patch->>'transfer_to_account_id')::uuid ELSE v_old.transfer_to_account_id END;
  v_category := CASE WHEN p_patch ? 'category_id' THEN (p_patch->>'category_id')::uuid
    ELSE v_old.category_id END;
  v_description := CASE WHEN p_patch ? 'description' THEN btrim(p_patch->>'description')
    ELSE v_old.description END;
  v_notes := CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE v_old.notes END;
  v_payment_method := CASE WHEN p_patch ? 'payment_method' THEN p_patch->>'payment_method'
    ELSE v_old.payment_method END;
  IF (p_patch ? 'date' AND to_char(v_date,'YYYY-MM-DD') <> p_patch->>'date')
    OR (p_patch ? 'amount' AND (p_patch->>'amount')::numeric <> v_amount)
    OR v_amount <= 0 OR v_type NOT IN ('expense','income','transfer')
    OR length(btrim(v_description)) = 0
    OR length(coalesce(v_payment_method,'')) > 50
    OR (v_type = 'transfer' AND (v_to_account IS NULL OR v_to_account = v_account))
    OR (v_type <> 'transfer' AND v_to_account IS NOT NULL) THEN
    RAISE EXCEPTION 'Invalid amount, type, account destination, or description'
      USING ERRCODE = '22023';
  END IF;
  v_financial_change := (v_old.type,v_old.amount,v_old.account_id,v_old.transfer_to_account_id)
    IS DISTINCT FROM (v_type,v_amount,v_account,v_to_account);
  IF v_financial_change AND v_old.type = 'transfer'
    AND v_old.transfer_to_account_id IS NULL THEN
    RAISE EXCEPTION 'Legacy transfer without destination needs manual review'
      USING ERRCODE = '23514';
  END IF;

  FOR v_lock_account IN
    SELECT DISTINCT id FROM unnest(ARRAY[v_old.account_id,v_old.transfer_to_account_id,
      v_account,v_to_account]) AS id WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM 1 FROM public.accounts WHERE id = v_lock_account AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT * INTO v_locked FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;
  IF to_jsonb(v_locked) IS DISTINCT FROM to_jsonb(v_old) THEN
    RAISE EXCEPTION 'Transaction changed during review; retry from current data'
      USING ERRCODE = '23514';
  END IF;
  IF v_financial_change AND (
    NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = v_account AND user_id = v_user
      AND is_active AND deleted_at IS NULL)
    OR (v_to_account IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounts WHERE id = v_to_account AND user_id = v_user
        AND is_active AND deleted_at IS NULL))) THEN
    RAISE EXCEPTION 'New account is inactive or deleted' USING ERRCODE = '23514';
  END IF;
  IF v_category IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.categories WHERE id = v_category AND user_id = v_user
      AND type = v_type AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Category does not belong to caller or match transaction type'
      USING ERRCODE = '42501';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.document_observation_decisions
    WHERE user_id = v_user AND transaction_id = p_transaction_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_inbox_match_decisions d
      WHERE d.user_id = v_user AND d.transaction_id = p_transaction_id
        AND NOT EXISTS (SELECT 1 FROM public.shortcut_inbox_match_reversals r
          WHERE r.decision_id = d.id)) INTO v_reviewed;
  IF v_reviewed AND (v_financial_change OR
    (v_old.date,v_old.time,v_old.payment_method) IS DISTINCT FROM (v_date,v_time,v_payment_method)) THEN
    RAISE EXCEPTION 'Reviewed document or Shortcut match blocks financial transaction edits'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.transactions SET date = v_date, time = v_time, amount = v_amount,
    description = v_description, notes = v_notes, category_id = v_category,
    account_id = v_account, type = v_type, payment_method = v_payment_method,
    transfer_to_account_id = v_to_account, updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user RETURNING * INTO v_new;
  IF v_financial_change THEN
    IF v_old.type = 'expense' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
    ELSIF v_old.type = 'income' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
    ELSE
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_old.amount
        WHERE id = v_old.account_id AND user_id = v_user;
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_old.amount
        WHERE id = v_old.transfer_to_account_id AND user_id = v_user;
    END IF;
    IF v_type = 'expense' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_amount
        WHERE id = v_account AND user_id = v_user;
    ELSIF v_type = 'income' THEN
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_amount
        WHERE id = v_account AND user_id = v_user;
    ELSE
      UPDATE public.accounts SET balance = coalesce(balance,0) - v_amount
        WHERE id = v_account AND user_id = v_user;
      UPDATE public.accounts SET balance = coalesce(balance,0) + v_amount
        WHERE id = v_to_account AND user_id = v_user;
    END IF;
  END IF;
  IF v_reviewed AND (v_old.category_id,v_old.description,v_old.notes)
    IS DISTINCT FROM (v_new.category_id,v_new.description,v_new.notes) THEN
    INSERT INTO public.transaction_review_metadata_edits(user_id,transaction_id,before_state,after_state)
    VALUES (v_user,p_transaction_id,
      jsonb_build_object('category_id',v_old.category_id,'description',v_old.description,'notes',v_old.notes),
      jsonb_build_object('category_id',v_new.category_id,'description',v_new.description,'notes',v_new.notes));
  END IF;
  RETURN to_jsonb(v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.patch_reviewed_transaction(uuid,jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.patch_reviewed_transaction(uuid,jsonb) TO authenticated;
