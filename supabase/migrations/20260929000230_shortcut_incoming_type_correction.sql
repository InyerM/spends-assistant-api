-- Repair a reviewed incoming bank transfer that a historical parser stored as an expense.
-- The immutable matched SMS proves the cash direction, while the owner-reviewed role
-- distinguishes principal repayment, sale proceeds, and restricted donations.
-- A debit-card suffix and its underlying bank-account suffix are different identifiers.
ALTER TABLE public.accounts ADD COLUMN bank_account_last_four varchar(4)
  CHECK (bank_account_last_four ~ '^[0-9]{4}$');
CREATE UNIQUE INDEX accounts_owner_bank_account_suffix_idx
  ON public.accounts (user_id, lower(institution), bank_account_last_four)
  WHERE bank_account_last_four IS NOT NULL AND deleted_at IS NULL;

CREATE TYPE public.shortcut_incoming_flow_role AS ENUM (
  'receivable_principal_repayment',
  'personal_sale_proceeds',
  'earmarked_relief_donation'
);

CREATE TABLE public.shortcut_incoming_type_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL,
  match_decision_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  flow_role public.shortcut_incoming_flow_role NOT NULL,
  old_type text NOT NULL DEFAULT 'expense' CHECK (old_type = 'expense'),
  new_type text NOT NULL DEFAULT 'income' CHECK (new_type = 'income'),
  notice_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_incoming_correction_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT shortcut_incoming_correction_transaction_unique UNIQUE (user_id, transaction_id),
  CONSTRAINT shortcut_incoming_correction_transaction_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_incoming_correction_decision_fk
    FOREIGN KEY (match_decision_id, user_id, transaction_id)
    REFERENCES public.shortcut_inbox_match_decisions (id, user_id, transaction_id)
    ON DELETE CASCADE,
  CONSTRAINT shortcut_incoming_correction_inbox_fk
    FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items (id, user_id) ON DELETE CASCADE
);

CREATE FUNCTION public.reject_shortcut_incoming_correction_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut incoming corrections are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_incoming_corrections_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_incoming_type_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_incoming_correction_mutation();

ALTER TABLE public.shortcut_incoming_type_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_incoming_correction_select_owner
  ON public.shortcut_incoming_type_corrections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_incoming_type_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_incoming_type_corrections TO authenticated, service_role;

CREATE FUNCTION public.correct_shortcut_matched_incoming_transfer(
  p_request_id uuid,
  p_transaction_id uuid,
  p_match_decision_id uuid,
  p_expected_account_id uuid,
  p_expected_amount numeric,
  p_expected_date date,
  p_expected_time time,
  p_flow_role public.shortcut_incoming_flow_role
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.shortcut_incoming_type_corrections%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_inbox_id uuid;
  v_inbox_status text;
  v_notice text;
  v_notice_parts text[];
  v_account public.accounts%ROWTYPE;
  v_correction public.shortcut_incoming_type_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_transaction_id IS NULL OR p_match_decision_id IS NULL
    OR p_expected_account_id IS NULL OR p_expected_amount IS NULL
    OR p_expected_date IS NULL OR p_expected_time IS NULL OR p_flow_role IS NULL
    OR p_expected_amount <= 0
    OR p_expected_amount <> p_expected_amount::numeric(15,2) THEN
    RAISE EXCEPTION 'A complete incoming correction with a positive two-decimal amount is required'
      USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'transaction_id', p_transaction_id, 'match_decision_id', p_match_decision_id,
    'expected_account_id', p_expected_account_id, 'expected_amount', p_expected_amount,
    'expected_date', p_expected_date, 'expected_time', p_expected_time,
    'flow_role', p_flow_role)::text);

  -- Serialize with manual edits and with a reversal of this inbox match.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.shortcut_incoming_type_corrections
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

  SELECT * INTO v_account FROM public.accounts
    WHERE id = v_old.account_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
  END IF;
  IF v_account.type <> 'savings' OR NOT coalesce(v_account.is_active, false)
    OR v_account.deleted_at IS NOT NULL
    OR lower(btrim(coalesce(v_account.institution, ''))) <> 'bancolombia' THEN
    RAISE EXCEPTION 'Incoming transfer requires an active Bancolombia savings account'
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
    OR v_locked.date IS DISTINCT FROM p_expected_date
    OR v_locked.time IS DISTINCT FROM p_expected_time THEN
    RAISE EXCEPTION 'Transaction changed during review; refresh the incoming match'
      USING ERRCODE = '40001';
  END IF;
  IF v_locked.type <> 'expense' OR v_locked.transfer_to_account_id IS NOT NULL
    OR v_locked.category_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only uncategorized single-account expenses can use this correction'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_observation_decisions
    WHERE user_id = v_user AND transaction_id = p_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed document decision requires a separate correction'
      USING ERRCODE = '23514';
  END IF;

  -- Match the immutable Bancolombia SMS to the live amount, account, date, and time.
  v_notice_parts := regexp_match(v_notice,
    '^Bancolombia:[[:space:]]+[^,]{1,100},[[:space:]]+recibiste[[:space:]]+una[[:space:]]+transferencia[[:space:]]+de[[:space:]]+.+[[:space:]]+por[[:space:]]+[$]([0-9]{1,3}(?:,[0-9]{3})*[.][0-9]{2})[[:space:]]+en[[:space:]]+tu[[:space:]]+cuenta[[:space:]]+[*]([0-9]{4})[[:space:]]+conectada[[:space:]]+a[[:space:]]+la[[:space:]]+llave[[:space:]]+[0-9]+[[:space:]]+el[[:space:]]+([0-9]{2}/[0-9]{2}/[0-9]{2})[[:space:]]+a[[:space:]]+las[[:space:]]+([0-9]{2}:[0-9]{2})[.]',
    'i');
  IF v_notice_parts IS NULL
    OR replace(v_notice_parts[1], ',', '')::numeric IS DISTINCT FROM v_locked.amount
    OR v_notice_parts[2] IS DISTINCT FROM
      coalesce(v_account.bank_account_last_four, v_account.last_four)
    OR v_notice_parts[3] IS DISTINCT FROM to_char(v_locked.date, 'DD/MM/YY')
    OR v_notice_parts[4] IS DISTINCT FROM to_char(v_locked.time, 'HH24:MI') THEN
    RAISE EXCEPTION 'Shortcut notice does not prove matching incoming transfer'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.transactions SET type = 'income', updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance, 0) + 2 * v_locked.amount
    WHERE id = v_locked.account_id AND user_id = v_user;
  INSERT INTO public.shortcut_incoming_type_corrections (
    user_id, request_id, request_hash, transaction_id, match_decision_id,
    inbox_item_id, account_id, amount, flow_role, notice_hash
  ) VALUES (
    v_user, p_request_id, v_hash, p_transaction_id, p_match_decision_id,
    v_inbox_id, v_locked.account_id, v_locked.amount, p_flow_role, md5(v_notice)
  ) RETURNING * INTO v_correction;
  RETURN jsonb_build_object('correction', to_jsonb(v_correction), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_shortcut_matched_incoming_transfer(
  uuid, uuid, uuid, uuid, numeric, date, time, public.shortcut_incoming_flow_role)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.correct_shortcut_matched_incoming_transfer(
  uuid, uuid, uuid, uuid, numeric, date, time, public.shortcut_incoming_flow_role)
  TO authenticated;

-- The existing reversal RPC remains available for ordinary matches. A corrected
-- live financial row must first receive an explicit audited undo, which does not
-- exist yet, before its evidence can be detached.
CREATE FUNCTION public.guard_audited_shortcut_match_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_transaction_id uuid;
BEGIN
  SELECT d.transaction_id INTO v_transaction_id
    FROM public.shortcut_inbox_match_decisions d
    JOIN public.transactions t ON t.id = d.transaction_id AND t.user_id = d.user_id
    WHERE d.id = NEW.decision_id AND d.user_id = NEW.user_id
      AND d.inbox_item_id = NEW.inbox_item_id AND t.deleted_at IS NULL;
  IF v_transaction_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.shortcut_transaction_financial_corrections c
      WHERE c.user_id = NEW.user_id AND c.transaction_id = v_transaction_id
        AND c.match_decision_id = NEW.decision_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_payroll_type_corrections c
      WHERE c.user_id = NEW.user_id AND c.transaction_id = v_transaction_id
        AND c.match_decision_id = NEW.decision_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_incoming_type_corrections c
      WHERE c.user_id = NEW.user_id AND c.transaction_id = v_transaction_id
        AND c.match_decision_id = NEW.decision_id) THEN
    RAISE EXCEPTION 'Audited financial correction requires a separate undo before match reversal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shortcut_audited_match_reversal_guard
  BEFORE INSERT ON public.shortcut_inbox_match_reversals
  FOR EACH ROW EXECUTE FUNCTION public.guard_audited_shortcut_match_reversal();
