-- Preserve source and posting currencies without changing historical balances.
-- Existing COP account postings can be labeled COP; their original source
-- amounts remain unknown until reviewed.
ALTER TABLE public.transactions
  ADD COLUMN currency varchar(3),
  ADD COLUMN source_currency varchar(3),
  ADD COLUMN source_amount numeric(15,2),
  ADD COLUMN destination_amount numeric(15,2),
  ADD COLUMN fx_rate numeric(20,10),
  ADD COLUMN fx_rate_source text,
  ADD COLUMN fx_effective_date date;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_posting_currency_supported
    CHECK (currency IS NULL OR currency IN ('COP', 'USD')),
  ADD CONSTRAINT transactions_source_currency_supported
    CHECK (source_currency IS NULL OR source_currency IN ('COP', 'USD')),
  ADD CONSTRAINT transactions_source_amount_positive
    CHECK (source_amount IS NULL OR source_amount > 0),
  ADD CONSTRAINT transactions_destination_amount_positive
    CHECK (destination_amount IS NULL OR destination_amount > 0),
  ADD CONSTRAINT transactions_fx_rate_positive
    CHECK (fx_rate IS NULL OR fx_rate > 0),
  ADD CONSTRAINT transactions_fx_rate_source_supported
    CHECK (fx_rate_source IS NULL OR fx_rate_source IN
      ('bank_posting', 'p2p', 'manual', 'banrep_reference'));

-- Do not rewrite an audited event's updated_at merely to label its posting
-- currency. Migration DDL and the update run in the same transaction.
ALTER TABLE public.transactions DISABLE TRIGGER transactions_updated_at;
UPDATE public.transactions AS t
SET currency = 'COP'
FROM public.accounts AS a
WHERE a.id = t.account_id AND a.user_id = t.user_id
  AND a.currency = 'COP' AND t.currency IS NULL;
ALTER TABLE public.transactions ENABLE TRIGGER transactions_updated_at;

CREATE FUNCTION public.enforce_transaction_currency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_account_currency text;
  v_account_owner uuid;
  v_destination_currency text;
  v_destination_owner uuid;
BEGIN
  SELECT a.currency, a.user_id INTO v_account_currency, v_account_owner
  FROM public.accounts AS a WHERE a.id = NEW.account_id;
  IF v_account_owner IS NULL OR v_account_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'Transaction account does not belong to owner' USING ERRCODE = '42501';
  END IF;

  -- Legacy writers only produce COP. An omitted currency on a USD account
  -- must fail closed until that writer explicitly supports USD.
  IF NEW.currency IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      NEW.currency := 'COP';
    ELSE
      RAISE EXCEPTION 'Historical transaction currency requires review'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_account_currency IS NULL OR v_account_currency NOT IN ('COP', 'USD')
    OR NEW.currency NOT IN ('COP', 'USD') OR NEW.currency <> v_account_currency THEN
    RAISE EXCEPTION 'Transaction currency must match account currency'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.source_currency IS NULL THEN
    NEW.source_currency := NEW.currency;
  END IF;
  IF NEW.source_currency IS NULL THEN
    IF NEW.source_amount IS NOT NULL OR NEW.fx_rate IS NOT NULL
      OR NEW.fx_rate_source IS NOT NULL OR NEW.fx_effective_date IS NOT NULL THEN
      RAISE EXCEPTION 'Unknown historical source cannot carry exchange rate data'
        USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.source_currency IS NOT NULL THEN
      RAISE EXCEPTION 'Reviewed source currency cannot be cleared'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.source_currency NOT IN ('COP', 'USD') THEN
      RAISE EXCEPTION 'Unsupported source currency' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.amount IS DISTINCT FROM OLD.amount
      AND OLD.source_currency = OLD.currency AND NEW.source_currency = NEW.currency
      AND OLD.source_amount = OLD.amount AND NEW.source_amount = OLD.source_amount THEN
      NEW.source_amount := NEW.amount;
    END IF;
    IF NEW.source_amount IS NULL THEN
      IF NEW.source_currency <> NEW.currency THEN
        RAISE EXCEPTION 'Original amount is required for exchange rate'
          USING ERRCODE = '23514';
      END IF;
      NEW.source_amount := NEW.amount;
    END IF;
    IF NEW.source_amount <= 0 THEN
      RAISE EXCEPTION 'Original amount must be positive' USING ERRCODE = '23514';
    END IF;

    IF NEW.source_currency = NEW.currency THEN
      IF NEW.source_amount <> NEW.amount OR NEW.fx_rate IS NOT NULL
        OR NEW.fx_rate_source IS NOT NULL OR NEW.fx_effective_date IS NOT NULL THEN
        RAISE EXCEPTION 'Same-currency amount cannot carry exchange rate data'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.fx_rate IS NULL OR NEW.fx_rate <= 0 OR NEW.fx_rate_source IS NULL
        OR NEW.fx_effective_date IS NULL
        OR abs(round(NEW.source_amount * NEW.fx_rate, 2) - NEW.amount) > 0.01 THEN
        RAISE EXCEPTION 'Original and posted amounts require a consistent exchange rate'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.transfer_to_account_id IS NOT NULL THEN
    IF NEW.type <> 'transfer' OR NEW.transfer_to_account_id = NEW.account_id THEN
      RAISE EXCEPTION 'Invalid transfer destination' USING ERRCODE = '23514';
    END IF;
    SELECT a.currency, a.user_id INTO v_destination_currency, v_destination_owner
    FROM public.accounts AS a WHERE a.id = NEW.transfer_to_account_id;
    IF v_destination_owner IS NULL OR v_destination_owner <> NEW.user_id THEN
      RAISE EXCEPTION 'Transfer account does not belong to owner' USING ERRCODE = '42501';
    END IF;
    IF v_destination_currency <> NEW.currency THEN
      RAISE EXCEPTION 'Cross-currency transfer requires an atomic two-leg writer'
        USING ERRCODE = '23514';
    END IF;
    NEW.destination_amount := coalesce(NEW.destination_amount, NEW.amount);
    IF NEW.destination_amount <> NEW.amount THEN
      RAISE EXCEPTION 'Same-currency transfer amounts must match'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.destination_amount IS NOT NULL THEN
    RAISE EXCEPTION 'Destination amount requires a transfer account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_currency_guard
BEFORE INSERT OR UPDATE OF user_id, account_id, transfer_to_account_id,
  amount, currency, source_currency, source_amount, destination_amount,
  fx_rate, fx_rate_source, fx_effective_date
ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.enforce_transaction_currency();
REVOKE ALL ON FUNCTION public.enforce_transaction_currency()
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.prevent_account_currency_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.currency IS DISTINCT FROM NEW.currency AND (
    coalesce(OLD.balance, 0) <> 0
    OR EXISTS (SELECT 1 FROM public.transactions AS t WHERE t.account_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.transactions AS t
      WHERE t.transfer_to_account_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Account currency cannot change after transaction history exists'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_currency_reassignment_guard
BEFORE UPDATE OF currency ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.prevent_account_currency_reassignment();
REVOKE ALL ON FUNCTION public.prevent_account_currency_reassignment()
  FROM PUBLIC, anon, authenticated;
