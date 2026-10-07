-- A financial account may be referenced by its bank number and several card numbers.
-- The primary active identifier is mirrored to last_four for existing clients.
ALTER TABLE public.accounts
  ADD COLUMN identifiers jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.accounts
SET identifiers = (
  SELECT coalesce(jsonb_agg(identifier ORDER BY position), '[]'::jsonb)
  FROM (
    SELECT 1 AS position, jsonb_build_object(
      'kind', CASE WHEN type = 'credit_card' THEN 'credit_card'
                   WHEN type IN ('savings', 'checking') AND
                        bank_account_last_four IS DISTINCT FROM last_four THEN 'debit_card'
                   ELSE 'bank_account' END,
      'last_four', last_four, 'is_active', true, 'is_primary', true
    ) AS identifier
    WHERE last_four IS NOT NULL
    UNION ALL
    SELECT 2, jsonb_build_object('kind', 'bank_account',
      'last_four', bank_account_last_four, 'is_active', true,
      'is_primary', last_four IS NULL)
    WHERE bank_account_last_four IS NOT NULL
      AND bank_account_last_four IS DISTINCT FROM last_four
  ) existing_identifiers
);

CREATE FUNCTION public.validate_account_identifiers()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  identifier jsonb;
  suffixes text[] := '{}';
  primary_count integer := 0;
  bank_suffix text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.identifiers = '[]'::jsonb AND NEW.last_four IS NOT NULL THEN
    NEW.identifiers := jsonb_build_array(jsonb_build_object(
      'kind', CASE WHEN NEW.type = 'credit_card' THEN 'credit_card'
                   WHEN NEW.type IN ('savings', 'checking') AND
                        NEW.bank_account_last_four IS DISTINCT FROM NEW.last_four
                   THEN 'debit_card' ELSE 'bank_account' END,
      'last_four', NEW.last_four, 'is_active', true, 'is_primary', true));
    IF NEW.bank_account_last_four IS NOT NULL AND
      NEW.bank_account_last_four IS DISTINCT FROM NEW.last_four THEN
      NEW.identifiers := NEW.identifiers || jsonb_build_array(jsonb_build_object(
        'kind', 'bank_account', 'last_four', NEW.bank_account_last_four,
        'is_active', true, 'is_primary', false));
    END IF;
  END IF;
  IF jsonb_typeof(NEW.identifiers) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.identifiers) > 12 THEN
    RAISE EXCEPTION 'Invalid account identifiers';
  END IF;
  FOR identifier IN SELECT value FROM jsonb_array_elements(NEW.identifiers) LOOP
    IF jsonb_typeof(identifier) IS DISTINCT FROM 'object'
      OR coalesce(identifier->>'kind', '') NOT IN
        ('bank_account', 'debit_card', 'credit_card', 'other')
      OR coalesce(identifier->>'last_four', '') !~ '^[0-9]{4}$'
      OR jsonb_typeof(identifier->'is_active') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(identifier->'is_primary') IS DISTINCT FROM 'boolean'
      OR identifier->>'last_four' = ANY(suffixes) THEN
      RAISE EXCEPTION 'Invalid or duplicate account identifier';
    END IF;
    suffixes := array_append(suffixes, identifier->>'last_four');
    IF identifier->>'kind' = 'bank_account' AND
      (bank_suffix IS NULL OR identifier->>'is_primary' = 'true') THEN
      bank_suffix := identifier->>'last_four';
    END IF;
    IF identifier->>'is_primary' = 'true' THEN
      primary_count := primary_count + 1;
      IF identifier->>'is_active' != 'true' THEN
        RAISE EXCEPTION 'A retired identifier cannot be primary';
      END IF;
      NEW.last_four := identifier->>'last_four';
    END IF;
  END LOOP;
  IF (jsonb_array_length(NEW.identifiers) > 0 AND primary_count != 1)
    OR (jsonb_array_length(NEW.identifiers) = 0 AND primary_count != 0) THEN
    RAISE EXCEPTION 'Exactly one active primary identifier is required';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.identifiers IS DISTINCT FROM OLD.identifiers THEN
    NEW.last_four := CASE WHEN primary_count = 0 THEN NULL ELSE NEW.last_four END;
    NEW.bank_account_last_four := bank_suffix;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_account_identifiers_before_write
BEFORE INSERT OR UPDATE OF identifiers ON public.accounts
FOR EACH ROW EXECUTE FUNCTION public.validate_account_identifiers();
