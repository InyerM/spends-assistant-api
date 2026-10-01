-- Preserve the original Shortcut match while correcting a statement-confirmed
-- credit-card payment from expense to a savings-to-card transfer.
CREATE TABLE public.shortcut_card_payment_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL,
  match_decision_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  old_account_id uuid NOT NULL,
  source_account_id uuid NOT NULL,
  destination_account_id uuid NOT NULL,
  old_category_id uuid,
  transfer_category_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  old_type text NOT NULL DEFAULT 'expense' CHECK (old_type = 'expense'),
  new_type text NOT NULL DEFAULT 'transfer' CHECK (new_type = 'transfer'),
  notice_hash text NOT NULL,
  statement_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_card_payment_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT shortcut_card_payment_transaction_unique UNIQUE (user_id, transaction_id),
  CONSTRAINT shortcut_card_payment_transaction_fk FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_card_payment_decision_fk
    FOREIGN KEY (match_decision_id, user_id, transaction_id)
    REFERENCES public.shortcut_inbox_match_decisions (id, user_id, transaction_id)
    ON DELETE CASCADE,
  CONSTRAINT shortcut_card_payment_inbox_fk FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items (id, user_id) ON DELETE CASCADE
);

CREATE FUNCTION public.reject_shortcut_card_payment_correction_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut card payment corrections are append-only'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_card_payment_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_card_payment_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_card_payment_correction_mutation();
ALTER TABLE public.shortcut_card_payment_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_card_payment_correction_select_owner
  ON public.shortcut_card_payment_corrections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_card_payment_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_card_payment_corrections TO authenticated, service_role;

CREATE FUNCTION public.correct_shortcut_card_payment(
  p_request_id uuid, p_transaction_id uuid, p_match_decision_id uuid,
  p_expected_account_id uuid, p_expected_amount numeric,
  p_expected_category_id uuid, p_expected_date date, p_expected_time time,
  p_source_account_id uuid, p_destination_account_id uuid,
  p_transfer_category_id uuid, p_statement_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.shortcut_card_payment_corrections%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_inbox_id uuid;
  v_inbox_status text;
  v_notice text;
  v_parts text[];
  v_account_id uuid;
  v_source public.accounts%ROWTYPE;
  v_destination public.accounts%ROWTYPE;
  v_correction public.shortcut_card_payment_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transaction_id IS NULL OR p_match_decision_id IS NULL
    OR p_expected_account_id IS NULL OR p_expected_amount IS NULL
    OR p_expected_date IS NULL OR p_expected_time IS NULL
    OR p_source_account_id IS NULL OR p_destination_account_id IS NULL
    OR p_transfer_category_id IS NULL OR p_source_account_id = p_destination_account_id
    OR p_expected_amount <= 0 OR p_expected_amount <> p_expected_amount::numeric(15,2) THEN
    RAISE EXCEPTION 'A complete positive card payment correction is required'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_statement_evidence) IS DISTINCT FROM 'object'
    OR p_statement_evidence->>'source' IS DISTINCT FROM 'card_statement'
    OR coalesce(p_statement_evidence->>'document','') !~ '^[A-Za-z0-9_.-]{1,120}[.]pdf$'
    OR coalesce(p_statement_evidence->>'sha256','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_statement_evidence->>'page','') !~ '^[1-9][0-9]{0,2}$'
    OR coalesce(p_statement_evidence->>'posting','') !~ '^[A-Za-z0-9-]{1,40}$'
    OR coalesce(p_statement_evidence->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR coalesce(p_statement_evidence->>'amount','') !~ '^(0|[1-9][0-9]{0,12})[.][0-9]{2}$' THEN
    RAISE EXCEPTION 'Statement document, hash, page, posting, date, and amount are required'
      USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'transaction_id', p_transaction_id, 'match_decision_id', p_match_decision_id,
    'expected_account_id', p_expected_account_id, 'expected_amount', p_expected_amount,
    'expected_category_id', p_expected_category_id,
    'expected_date', p_expected_date, 'expected_time', p_expected_time,
    'source_account_id', p_source_account_id,
    'destination_account_id', p_destination_account_id,
    'transfer_category_id', p_transfer_category_id,
    'statement_evidence', p_statement_evidence)::text);

  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.shortcut_card_payment_corrections
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002'; END IF;
  SELECT inbox_item_id INTO v_inbox_id FROM public.shortcut_inbox_match_decisions
    WHERE id = p_match_decision_id AND user_id = v_user
      AND transaction_id = p_transaction_id AND decision_type = 'matched';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active Shortcut match not found' USING ERRCODE = 'P0002'; END IF;
  SELECT status, raw_text INTO v_inbox_status, v_notice
    FROM public.shortcut_inbox_items WHERE id = v_inbox_id AND user_id = v_user FOR UPDATE;
  IF v_inbox_status IS DISTINCT FROM 'matched' OR EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_reversals
      WHERE decision_id = p_match_decision_id) THEN
    RAISE EXCEPTION 'Active Shortcut match required' USING ERRCODE = '23514';
  END IF;

  -- Lock accounts in the same UUID order used by manual financial writes.
  FOR v_account_id IN SELECT DISTINCT id FROM unnest(ARRAY[
    v_old.account_id, p_source_account_id, p_destination_account_id
  ]) AS id ORDER BY id LOOP
    PERFORM 1 FROM public.accounts WHERE id = v_account_id AND user_id = v_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501'; END IF;
  END LOOP;
  SELECT * INTO v_source FROM public.accounts
    WHERE id = p_source_account_id AND user_id = v_user;
  SELECT * INTO v_destination FROM public.accounts
    WHERE id = p_destination_account_id AND user_id = v_user;
  IF v_source.type <> 'savings' OR v_destination.type <> 'credit_card'
    OR lower(btrim(coalesce(v_source.institution,''))) <> 'bancolombia'
    OR lower(btrim(coalesce(v_destination.institution,''))) <> 'bancolombia'
    OR NOT coalesce(v_source.is_active,false) OR NOT coalesce(v_destination.is_active,false)
    OR v_source.deleted_at IS NOT NULL OR v_destination.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Active Bancolombia savings and credit card accounts are required'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.categories
    WHERE id = p_transfer_category_id AND user_id = v_user AND type = 'transfer'
      AND slug = 'transfer-between-accounts' AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Active transfer-between-accounts category is required'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_locked FROM public.transactions
    WHERE id = p_transaction_id AND user_id = v_user AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'P0002'; END IF;
  IF to_jsonb(v_locked) IS DISTINCT FROM to_jsonb(v_old)
    OR v_locked.account_id IS DISTINCT FROM p_expected_account_id
    OR v_locked.amount IS DISTINCT FROM p_expected_amount
    OR v_locked.category_id IS DISTINCT FROM p_expected_category_id
    OR v_locked.date IS DISTINCT FROM p_expected_date
    OR v_locked.time IS DISTINCT FROM p_expected_time THEN
    RAISE EXCEPTION 'Transaction changed during review; refresh the card payment'
      USING ERRCODE = '40001';
  END IF;
  IF v_locked.type <> 'expense' OR v_locked.transfer_to_account_id IS NOT NULL
    OR v_locked.account_id NOT IN (p_source_account_id, p_destination_account_id)
    OR v_locked.raw_text IS DISTINCT FROM v_notice THEN
    RAISE EXCEPTION 'Only an SMS-matched single-account card payment expense can be corrected'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_observation_decisions
    WHERE user_id = v_user AND transaction_id = p_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed document decision requires a separate correction'
      USING ERRCODE = '23514';
  END IF;

  v_parts := regexp_match(v_notice,
    '^Bancolombia:[[:space:]]+Pagaste[[:space:]]+[$]([0-9]{1,3}(?:,[0-9]{3})*(?:[.][0-9]{2})?)[[:space:]]+en[[:space:]]+la[[:space:]]+tarjeta[[:space:]]+de[[:space:]]+credito[[:space:]]+[*]([0-9]{4})[[:space:]]+desde[[:space:]]+la[[:space:]]+cuenta[[:space:]]+[*]([0-9]{4}),[[:space:]]+el[[:space:]]+([0-9]{2}/[0-9]{2}/[0-9]{4})[[:space:]]+([0-9]{2}:[0-9]{2})[.]',
    'i');
  IF v_parts IS NULL
    OR replace(v_parts[1], ',', '')::numeric IS DISTINCT FROM v_locked.amount
    OR v_parts[2] IS DISTINCT FROM v_destination.last_four
    OR v_parts[3] IS DISTINCT FROM coalesce(v_source.bank_account_last_four, v_source.last_four)
    OR v_parts[4] IS DISTINCT FROM to_char(v_locked.date, 'DD/MM/YYYY')
    OR v_parts[5] IS DISTINCT FROM to_char(v_locked.time, 'HH24:MI') THEN
    RAISE EXCEPTION 'Shortcut notice does not prove the matched card payment'
      USING ERRCODE = '23514';
  END IF;
  IF (p_statement_evidence->>'date')::date IS DISTINCT FROM v_locked.date
    OR (p_statement_evidence->>'amount')::numeric IS DISTINCT FROM v_locked.amount THEN
    RAISE EXCEPTION 'Statement posting must match the transaction date and amount'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.transactions SET type = 'transfer', account_id = p_source_account_id,
    transfer_to_account_id = p_destination_account_id,
    category_id = p_transfer_category_id, updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) + v_locked.amount
    WHERE id = v_locked.account_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) - v_locked.amount
    WHERE id = p_source_account_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance,0) + v_locked.amount
    WHERE id = p_destination_account_id AND user_id = v_user;
  INSERT INTO public.shortcut_card_payment_corrections (
    user_id, request_id, request_hash, transaction_id, match_decision_id,
    inbox_item_id, old_account_id, source_account_id, destination_account_id,
    old_category_id, transfer_category_id, amount, notice_hash, statement_evidence
  ) VALUES (
    v_user, p_request_id, v_hash, p_transaction_id, p_match_decision_id,
    v_inbox_id, v_locked.account_id, p_source_account_id, p_destination_account_id,
    v_locked.category_id, p_transfer_category_id, v_locked.amount,
    md5(v_notice), p_statement_evidence
  ) RETURNING * INTO v_correction;
  RETURN jsonb_build_object('correction', to_jsonb(v_correction), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_shortcut_card_payment(
  uuid,uuid,uuid,uuid,numeric,uuid,date,time,uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.correct_shortcut_card_payment(
  uuid,uuid,uuid,uuid,numeric,uuid,date,time,uuid,uuid,uuid,jsonb)
  TO authenticated;

-- A corrected live transaction needs an audited undo before detaching its SMS.
CREATE FUNCTION public.guard_shortcut_card_payment_match_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.shortcut_card_payment_corrections c
    JOIN public.transactions t ON t.id = c.transaction_id AND t.user_id = c.user_id
    WHERE c.user_id = NEW.user_id AND c.match_decision_id = NEW.decision_id
      AND c.inbox_item_id = NEW.inbox_item_id AND t.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Card payment correction requires a separate undo before match reversal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shortcut_card_payment_match_reversal_guard
  BEFORE INSERT ON public.shortcut_inbox_match_reversals
  FOR EACH ROW EXECUTE FUNCTION public.guard_shortcut_card_payment_match_reversal();
