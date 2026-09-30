-- Correct one reviewed Mastercard refund. The June statement line is pinned to
-- the reviewed archive; this migration does not itself change financial rows.
CREATE TABLE public.shortcut_card_refund_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id uuid NOT NULL,
  match_decision_id uuid NOT NULL,
  inbox_item_id uuid NOT NULL,
  account_id uuid NOT NULL,
  category_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount = 89991),
  old_type text NOT NULL DEFAULT 'expense' CHECK (old_type = 'expense'),
  new_type text NOT NULL DEFAULT 'income' CHECK (new_type = 'income'),
  notice_hash text NOT NULL,
  statement_archive_sha256 text NOT NULL
    CHECK (statement_archive_sha256 = 'f86f89479dbb2278764d066c614cdb423759b640cbaaab3190f5d0b02f52b7e4'),
  statement_member text NOT NULL DEFAULT '0265_JUN2026.pdf'
    CHECK (statement_member = '0265_JUN2026.pdf'),
  statement_reference text NOT NULL CHECK (statement_reference = 'T05840'),
  statement_date date NOT NULL CHECK (statement_date = '2026-05-26'),
  statement_merchant text NOT NULL DEFAULT 'MERCADO PAGO LIMITADA'
    CHECK (statement_merchant = 'MERCADO PAGO LIMITADA'),
  statement_amount numeric(15,2) NOT NULL CHECK (statement_amount = -89991),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_card_refund_request_unique UNIQUE (user_id, request_id),
  CONSTRAINT shortcut_card_refund_transaction_unique UNIQUE (user_id, transaction_id),
  CONSTRAINT shortcut_card_refund_transaction_fk
    FOREIGN KEY (transaction_id, user_id)
    REFERENCES public.transactions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT shortcut_card_refund_decision_fk
    FOREIGN KEY (match_decision_id, user_id, transaction_id)
    REFERENCES public.shortcut_inbox_match_decisions (id, user_id, transaction_id)
    ON DELETE CASCADE,
  CONSTRAINT shortcut_card_refund_inbox_fk
    FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items (id, user_id) ON DELETE CASCADE
);

CREATE FUNCTION public.reject_shortcut_card_refund_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'postgres'
    AND current_setting('app.shortcut_match_erasure', true) = 'on'
    AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Shortcut card refund corrections are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER shortcut_card_refund_immutable
  BEFORE UPDATE OR DELETE ON public.shortcut_card_refund_corrections
  FOR EACH ROW EXECUTE FUNCTION public.reject_shortcut_card_refund_mutation();

ALTER TABLE public.shortcut_card_refund_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY shortcut_card_refund_owner_select
  ON public.shortcut_card_refund_corrections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.shortcut_card_refund_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shortcut_card_refund_corrections TO authenticated, service_role;

CREATE FUNCTION public.correct_shortcut_card_refund(
  p_request_id uuid,
  p_reviewed boolean,
  p_transaction_id uuid,
  p_match_decision_id uuid,
  p_expected_account_id uuid,
  p_expected_amount numeric,
  p_expected_category_id uuid,
  p_expected_date date,
  p_expected_time time,
  p_statement_reference text,
  p_statement_date date,
  p_statement_amount numeric,
  p_statement_archive_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v_existing public.shortcut_card_refund_corrections%ROWTYPE;
  v_old public.transactions%ROWTYPE;
  v_locked public.transactions%ROWTYPE;
  v_decision public.shortcut_inbox_match_decisions%ROWTYPE;
  v_inbox public.shortcut_inbox_items%ROWTYPE;
  v_account public.accounts%ROWTYPE;
  v_notice_parts text[];
  v_correction public.shortcut_card_refund_corrections%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_reviewed IS DISTINCT FROM true
    OR p_transaction_id IS DISTINCT FROM '9afa26b4-1269-4fe4-bcac-ce01404819f5'::uuid
    OR p_match_decision_id IS NULL
    OR p_expected_account_id IS DISTINCT FROM '7d46c20e-5a80-4e2f-9a16-6a05a6da6c3e'::uuid
    OR p_expected_amount IS DISTINCT FROM 89991::numeric
    OR p_expected_category_id IS NULL
    OR p_expected_date IS DISTINCT FROM '2026-05-28'::date
    OR p_expected_time IS DISTINCT FROM '04:59'::time
    OR p_statement_reference IS DISTINCT FROM 'T05840'
    OR p_statement_date IS DISTINCT FROM '2026-05-26'::date
    OR p_statement_amount IS DISTINCT FROM -89991::numeric
    OR p_statement_archive_sha256 IS DISTINCT FROM
      'f86f89479dbb2278764d066c614cdb423759b640cbaaab3190f5d0b02f52b7e4' THEN
    RAISE EXCEPTION 'Exact reviewed Mastercard refund and statement evidence required'
      USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'transaction_id', p_transaction_id, 'decision_id', p_match_decision_id,
    'account_id', p_expected_account_id, 'amount', p_expected_amount,
    'category_id', p_expected_category_id, 'date', p_expected_date,
    'time', p_expected_time, 'statement_reference', p_statement_reference,
    'statement_date', p_statement_date, 'statement_amount', p_statement_amount,
    'archive_sha256', p_statement_archive_sha256)::text);

  -- Match the financial RPC lock order so a concurrent edit cannot slip in.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual:' || v_user::text, 0));
  SELECT * INTO v_existing FROM public.shortcut_card_refund_corrections
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
  SELECT * INTO v_decision FROM public.shortcut_inbox_match_decisions
    WHERE id = p_match_decision_id AND user_id = v_user
      AND transaction_id = p_transaction_id AND decision_type = 'matched';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Shortcut match not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_inbox FROM public.shortcut_inbox_items
    WHERE id = v_decision.inbox_item_id AND user_id = v_user FOR UPDATE;
  IF v_inbox.status IS DISTINCT FROM 'matched' OR EXISTS (
    SELECT 1 FROM public.shortcut_inbox_match_reversals
    WHERE decision_id = p_match_decision_id AND user_id = v_user) THEN
    RAISE EXCEPTION 'Active Shortcut match required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_account FROM public.accounts
    WHERE id = v_old.account_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account does not belong to caller' USING ERRCODE = '42501';
  END IF;
  IF v_account.type <> 'credit_card' OR NOT coalesce(v_account.is_active, false)
    OR v_account.deleted_at IS NOT NULL
    OR lower(btrim(coalesce(v_account.institution, ''))) <> 'bancolombia'
    OR v_account.last_four <> '0265' THEN
    RAISE EXCEPTION 'An active Bancolombia Mastercard account ending 0265 is required'
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
    OR v_locked.category_id IS DISTINCT FROM p_expected_category_id
    OR v_locked.date IS DISTINCT FROM p_expected_date
    OR v_locked.time IS DISTINCT FROM p_expected_time THEN
    RAISE EXCEPTION 'Transaction changed during review' USING ERRCODE = '40001';
  END IF;
  IF v_locked.type <> 'expense' OR v_locked.transfer_to_account_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.document_observation_decisions
      WHERE user_id = v_user AND transaction_id = p_transaction_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_transaction_financial_corrections
      WHERE user_id = v_user AND transaction_id = p_transaction_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_payroll_type_corrections
      WHERE user_id = v_user AND transaction_id = p_transaction_id)
    OR EXISTS (SELECT 1 FROM public.shortcut_incoming_type_corrections
      WHERE user_id = v_user AND transaction_id = p_transaction_id) THEN
    RAISE EXCEPTION 'Only an otherwise uncorrected single-account expense can be corrected'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.categories
    WHERE id = v_locked.category_id AND user_id = v_user
      AND type = 'income' AND slug = 'refunds' AND is_active AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'An active owner-owned Refunds income category is required'
      USING ERRCODE = '23514';
  END IF;
  IF v_decision.transaction_snapshot->>'type' IS DISTINCT FROM 'expense'
    OR v_decision.transaction_snapshot->>'account_id' IS DISTINCT FROM v_account.id::text
    OR (v_decision.transaction_snapshot->>'amount')::numeric IS DISTINCT FROM v_locked.amount
    OR v_decision.transaction_snapshot->>'date' IS DISTINCT FROM v_locked.date::text THEN
    RAISE EXCEPTION 'Shortcut match snapshot does not show the reviewed expense'
      USING ERRCODE = '23514';
  END IF;

  v_notice_parts := regexp_match(v_inbox.raw_text,
    '^Bancolombia:[[:space:]]+Recibiste[[:space:]]+la[[:space:]]+devolucion[[:space:]]+de[[:space:]]+[$]([0-9]{1,3}(?:,[0-9]{3})*[.][0-9]{2})[[:space:]]+por[[:space:]]+MERCADO[[:space:]]+PAGO[[:space:]]+LIMITADA[[:space:]]+en[[:space:]]+tu[[:space:]]+tarjeta[[:space:]]+de[[:space:]]+credito[[:space:]]+[*]([0-9]{4}),[[:space:]]+el[[:space:]]+([0-9]{2}:[0-9]{2})[[:space:]]+a[[:space:]]+las[[:space:]]+([0-9]{2}/[0-9]{2}/[0-9]{4})[.]',
    'i');
  IF v_notice_parts IS NULL
    OR replace(v_notice_parts[1], ',', '')::numeric IS DISTINCT FROM v_locked.amount
    OR v_notice_parts[2] IS DISTINCT FROM v_account.last_four
    OR v_notice_parts[3] IS DISTINCT FROM to_char(v_locked.time, 'HH24:MI')
    OR v_notice_parts[4] IS DISTINCT FROM to_char(v_locked.date, 'DD/MM/YYYY') THEN
    RAISE EXCEPTION 'Shortcut notice does not prove the matching card refund'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.transactions SET type = 'income', updated_at = now()
    WHERE id = p_transaction_id AND user_id = v_user;
  UPDATE public.accounts SET balance = coalesce(balance, 0) + 2 * v_locked.amount
    WHERE id = v_locked.account_id AND user_id = v_user;
  INSERT INTO public.shortcut_card_refund_corrections (
    user_id, request_id, request_hash, transaction_id, match_decision_id,
    inbox_item_id, account_id, category_id, amount, notice_hash,
    statement_archive_sha256, statement_reference, statement_date, statement_amount
  ) VALUES (
    v_user, p_request_id, v_hash, p_transaction_id, p_match_decision_id,
    v_inbox.id, v_account.id, v_locked.category_id, v_locked.amount, md5(v_inbox.raw_text),
    p_statement_archive_sha256, p_statement_reference, p_statement_date, p_statement_amount
  ) RETURNING * INTO v_correction;
  RETURN jsonb_build_object('correction', to_jsonb(v_correction), 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_shortcut_card_refund(
  uuid, boolean, uuid, uuid, uuid, numeric, uuid, date, time, text, date, numeric, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.correct_shortcut_card_refund(
  uuid, boolean, uuid, uuid, uuid, numeric, uuid, date, time, text, date, numeric, text)
  TO authenticated;

-- Keep the reviewed SMS attached while the corrected financial row is live.
CREATE FUNCTION public.guard_shortcut_card_refund_reversal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.shortcut_card_refund_corrections c
    JOIN public.transactions t ON t.id = c.transaction_id AND t.user_id = c.user_id
    WHERE c.match_decision_id = NEW.decision_id AND c.user_id = NEW.user_id
      AND t.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Audited card refund requires a separate undo before match reversal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shortcut_card_refund_reversal_guard
  BEFORE INSERT ON public.shortcut_inbox_match_reversals
  FOR EACH ROW EXECUTE FUNCTION public.guard_shortcut_card_refund_reversal();

CREATE FUNCTION public.guard_corrected_shortcut_card_refund()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.amount, NEW.date, NEW.time, NEW.type, NEW.category_id,
      NEW.account_id, NEW.transfer_to_account_id, NEW.user_id, NEW.deleted_at)
    IS NOT DISTINCT FROM
    (OLD.amount, OLD.date, OLD.time, OLD.type, OLD.category_id,
      OLD.account_id, OLD.transfer_to_account_id, OLD.user_id, OLD.deleted_at) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.shortcut_card_refund_corrections
    WHERE transaction_id = OLD.id AND user_id = OLD.user_id) THEN
    RAISE EXCEPTION 'Audited card refund requires a separate undo before financial edits'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shortcut_card_refund_financial_guard
  BEFORE UPDATE OF amount, date, time, type, category_id, account_id,
    transfer_to_account_id, user_id, deleted_at ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_corrected_shortcut_card_refund();
