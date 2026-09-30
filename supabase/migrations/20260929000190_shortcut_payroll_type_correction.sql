-- Correct a matched expense only when the immutable Shortcut notice proves incoming payroll.
-- The account, amount, category, date, time, match decision, and request are checked before any write.
CREATE TABLE public.shortcut_payroll_type_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL,
  match_decision_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  account_id uuid NOT NULL,
  category_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  old_type text NOT NULL DEFAULT 'expense' CHECK (old_type = 'expense'),
  new_type text NOT NULL DEFAULT 'income' CHECK (new_type = 'income'),
  notice_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_payroll_correction_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT shortcut_payroll_correction_transaction_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_payroll_correction_decision_fk
    FOREIGN KEY (match_decision_id, user_id, transaction_id)
    REFERENCES public.shortcut_inbox_match_decisions (id, user_id, transaction_id)
    ON DELETE CASCADE,
  CONSTRAINT shortcut_payroll_correction_inbox_fk
    FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items (id, user_id) ON DELETE CASCADE
);
CREATE INDEX shortcut_payroll_correction_transaction_idx
  ON public.shortcut_payroll_type_corrections (user_id, transaction_id, created_at DESC);

CREATE FUNCTION public.reject_shortcut_payroll_correction_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut payroll corrections are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_payroll_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_payroll_type_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_payroll_correction_mutation();

ALTER TABLE public.shortcut_payroll_type_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_payroll_correction_select_owner
  ON public.shortcut_payroll_type_corrections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_payroll_type_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_payroll_type_corrections TO authenticated, service_role;

CREATE FUNCTION public.correct_shortcut_matched_payroll(
  p_request_id uuid,
  p_transaction_id uuid,
  p_match_decision_id uuid,
  p_expected_account_id uuid,
  p_expected_amount numeric,
  p_expected_category_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.shortcut_payroll_type_corrections%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_inbox_id uuid;
  v_inbox_status text;
  v_notice text;
  v_notice_parts text[];
  v_account_type text;
  v_correction public.shortcut_payroll_type_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transaction_id IS NULL OR p_match_decision_id IS NULL
    OR p_expected_account_id IS NULL OR p_expected_amount IS NULL
    OR p_expected_category_id IS NULL OR p_expected_amount <= 0
    OR p_expected_amount <> p_expected_amount::numeric(15,2) THEN
    RAISE EXCEPTION 'A complete payroll correction with a positive two-decimal amount is required'
      USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'transaction_id', p_transaction_id, 'match_decision_id', p_match_decision_id,
    'expected_account_id', p_expected_account_id, 'expected_amount', p_expected_amount,
    'expected_category_id', p_expected_category_id)::text);

  -- Use the same owner lock as manual creates and edits, then lock the inbox,
  -- account, and transaction in the established financial RPC order.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.shortcut_payroll_type_corrections
    WHERE user_id = v_user AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'request_id already belongs to a different correction'
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('correction', to_jsonb(v_existing), 'replayed', true);
  END IF;

  SELECT * INTO v_old FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT inbox_item_id INTO v_inbox_id FROM public.shortcut_inbox_match_decisions
    WHERE id = p_match_decision_id AND user_id = v_user
      AND transaction_id = p_transaction_id AND decision_type = 'matched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Shortcut match not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT status, raw_text INTO v_inbox_status, v_notice
    FROM public.shortcut_inbox_items
    WHERE id = v_inbox_id AND user_id = v_user FOR UPDATE;
  IF v_inbox_status IS DISTINCT FROM 'matched' OR EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_reversals
      WHERE decision_id = p_match_decision_id) THEN
    RAISE EXCEPTION 'Active Shortcut match required' USING ERRCODE = '23514';
  END IF;

  SELECT type INTO v_account_type FROM public.accounts
    WHERE id = v_old.account_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
  END IF;
  IF v_account_type <> 'savings' THEN
    RAISE EXCEPTION 'Incoming payroll requires a savings account'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_locked FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002';
  END IF;
  IF to_jsonb(v_locked) IS DISTINCT FROM to_jsonb(v_old)
    OR v_locked.account_id IS DISTINCT FROM p_expected_account_id
    OR v_locked.amount IS DISTINCT FROM p_expected_amount
    OR v_locked.category_id IS DISTINCT FROM p_expected_category_id THEN
    RAISE EXCEPTION 'Transaction changed during review; refresh the payroll match'
      USING ERRCODE = '40001';
  END IF;
  IF v_locked.type <> 'expense' OR v_locked.transfer_to_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only single-account expenses can use this correction'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.categories
    WHERE id = v_locked.category_id AND user_id = v_user
      AND type = 'income' AND slug = 'wage' AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'An active owner-owned wage category is required'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_observation_decisions
    WHERE user_id = v_user AND transaction_id = p_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed document decision requires a separate correction'
      USING ERRCODE = '23514';
  END IF;

  -- Capture the amount and original event date/time from the immutable SMS.
  v_notice_parts := regexp_match(v_notice,
    '^Bancolombia:[[:space:]]+Recibiste[[:space:]]+un[[:space:]]+pago[[:space:]]+de[[:space:]]+N[oó]mina[[:space:]]+de[[:space:]]+.+[[:space:]]+por[[:space:]]+[$]([0-9]{1,3}(?:,[0-9]{3})*[.][0-9]{2})[[:space:]]+en[[:space:]]+tu[[:space:]]+cuenta[[:space:]]+de[[:space:]]+Ahorros[[:space:]]+el[[:space:]]+([0-9]{2}/[0-9]{2}/[0-9]{4})[[:space:]]+a[[:space:]]+las[[:space:]]+([0-9]{2}:[0-9]{2})[.]',
    'i');
  IF v_notice_parts IS NULL
    OR replace(v_notice_parts[1], ',', '')::numeric IS DISTINCT FROM v_locked.amount
    OR v_notice_parts[2] IS DISTINCT FROM to_char(v_locked.date, 'DD/MM/YYYY')
    OR v_notice_parts[3] IS DISTINCT FROM to_char(v_locked.time, 'HH24:MI') THEN
    RAISE EXCEPTION 'Shortcut notice does not prove matching incoming payroll'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.transactions SET type = 'income', updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) + 2 * v_locked.amount
    WHERE id = v_locked.account_id AND user_id = v_user;
  INSERT INTO public.shortcut_payroll_type_corrections (
    user_id, request_id, request_hash, transaction_id, match_decision_id,
    inbox_item_id, account_id, category_id, amount, notice_hash
  ) VALUES (
    v_user, p_request_id, v_hash, p_transaction_id, p_match_decision_id,
    v_inbox_id, v_locked.account_id, v_locked.category_id, v_locked.amount, md5(v_notice)
  ) RETURNING * INTO v_correction;
  RETURN jsonb_build_object('correction', to_jsonb(v_correction), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_shortcut_matched_payroll(
  uuid, uuid, uuid, uuid, numeric, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.correct_shortcut_matched_payroll(
  uuid, uuid, uuid, uuid, numeric, uuid) TO authenticated;
