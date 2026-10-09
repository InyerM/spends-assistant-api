-- Account recognition is shared by every client and never replaces user-authored rules.
ALTER TABLE public.automation_rules
  ADD COLUMN managed_account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  ADD COLUMN managed_identifier text;
ALTER TABLE public.automation_rules ADD CONSTRAINT managed_account_rule_pair
  CHECK ((managed_account_id IS NULL) = (managed_identifier IS NULL));
CREATE UNIQUE INDEX managed_account_rule_identity
  ON public.automation_rules(user_id, managed_account_id, managed_identifier)
  WHERE managed_account_id IS NOT NULL;

CREATE FUNCTION public.guard_managed_account_rule_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.managed_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Managed account rules are updated through account identifiers' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.managed_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'Managed account rule identity is server controlled' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE' AND
      (NEW.managed_account_id IS DISTINCT FROM OLD.managed_account_id OR
       NEW.managed_identifier IS DISTINCT FROM OLD.managed_identifier) THEN
      RAISE EXCEPTION 'Managed account rule identity is server controlled' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_managed_account_rule_identity
  BEFORE INSERT OR UPDATE OR DELETE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.guard_managed_account_rule_identity();

-- Older mobile clients edit last_four without sending the identifier collection.
-- Preserve aliases and promote the supplied ending through the existing validator.
CREATE FUNCTION public.bridge_legacy_account_primary_identifier()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  next_identifiers jsonb;
  primary_kind text;
BEGIN
  IF NEW.last_four IS NOT DISTINCT FROM OLD.last_four OR NEW.identifiers IS DISTINCT FROM OLD.identifiers THEN
    RETURN NEW;
  END IF;
  IF NEW.last_four IS NULL AND jsonb_array_length(NEW.identifiers) > 0 THEN
    RAISE EXCEPTION 'Use the account identifier editor to remove the primary identifier' USING ERRCODE = '22023';
  END IF;
  IF NEW.last_four IS NULL THEN RETURN NEW; END IF;
  IF NEW.last_four !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Invalid account identifier' USING ERRCODE = '22023';
  END IF;
  SELECT value->>'kind' INTO primary_kind FROM jsonb_array_elements(NEW.identifiers)
    WHERE value->>'is_primary' = 'true' LIMIT 1;
  primary_kind := CASE WHEN NEW.type = 'credit_card' THEN 'credit_card'
    ELSE coalesce(primary_kind, 'bank_account') END;
  SELECT coalesce(jsonb_agg(value || jsonb_build_object('is_primary', value->>'last_four' = NEW.last_four)
    || CASE WHEN value->>'last_four' = NEW.last_four THEN jsonb_build_object('is_active', true) ELSE '{}'::jsonb END), '[]'::jsonb)
    INTO next_identifiers FROM jsonb_array_elements(NEW.identifiers);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.identifiers) WHERE value->>'last_four' = NEW.last_four) THEN
    next_identifiers := next_identifiers || jsonb_build_array(jsonb_build_object(
      'kind', primary_kind, 'last_four', NEW.last_four, 'is_primary', true, 'is_active', true));
  END IF;
  NEW.identifiers := next_identifiers;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bridge_legacy_account_primary_identifier
  BEFORE UPDATE OF last_four ON public.accounts FOR EACH ROW
  EXECUTE FUNCTION public.bridge_legacy_account_primary_identifier();
CREATE TRIGGER validate_account_identifiers_legacy_write
  BEFORE UPDATE OF last_four ON public.accounts FOR EACH ROW
  EXECUTE FUNCTION public.validate_account_identifiers();

CREATE FUNCTION public.sync_account_detection_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  suffix text;
  suffixes text[] := '{}';
  keywords text[];
BEGIN
  IF NEW.is_active AND NEW.deleted_at IS NULL AND NEW.type <> 'cash' THEN
    IF jsonb_array_length(coalesce(NEW.identifiers, '[]'::jsonb)) > 0 THEN
      SELECT coalesce(array_agg(DISTINCT value->>'last_four' ORDER BY value->>'last_four'), '{}')
        INTO suffixes FROM jsonb_array_elements(NEW.identifiers)
        WHERE value->>'is_active' = 'true' AND nullif(value->>'last_four', '') IS NOT NULL;
    ELSIF nullif(btrim(NEW.last_four), '') IS NOT NULL THEN
      suffixes := ARRAY[btrim(NEW.last_four)];
    ELSIF nullif(btrim(NEW.institution), '') IS NOT NULL THEN
      suffixes := ARRAY[''];
    END IF;
  END IF;

  -- Soft deletion makes retired aliases disappear through the existing mobile sync protocol.
  UPDATE public.automation_rules SET is_active = false, deleted_at = now(), updated_at = now()
    WHERE managed_account_id = NEW.id
      AND (user_id <> NEW.user_id OR NOT (managed_identifier = ANY(suffixes)))
      AND deleted_at IS NULL;

  FOREACH suffix IN ARRAY suffixes LOOP
    keywords := array_remove(ARRAY[nullif(btrim(NEW.institution), ''), nullif(suffix, '')], NULL);
    INSERT INTO public.automation_rules
      (user_id, name, is_active, priority, rule_type, condition_logic, conditions, actions,
       managed_account_id, managed_identifier)
    VALUES (NEW.user_id, left('Account: ' || NEW.name || CASE WHEN suffix = '' THEN '' ELSE ' *' || suffix END, 200),
      true, 100, 'account_detection', 'and', jsonb_build_object('raw_text_contains', keywords),
      jsonb_build_object('set_account', NEW.id), NEW.id, suffix)
    ON CONFLICT (user_id, managed_account_id, managed_identifier) WHERE managed_account_id IS NOT NULL
    DO UPDATE SET name = EXCLUDED.name, is_active = true, priority = EXCLUDED.priority,
      rule_type = EXCLUDED.rule_type, condition_logic = EXCLUDED.condition_logic,
      conditions = EXCLUDED.conditions, actions = EXCLUDED.actions, deleted_at = NULL, updated_at = now();
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_account_detection_rules() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER sync_account_detection_rules_after_write
  AFTER INSERT OR UPDATE OF name, institution, type, identifiers, last_four, is_active, deleted_at, user_id
  ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.sync_account_detection_rules();

CREATE FUNCTION public.sync_owned_account_detection_rules()
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  owner_id uuid := auth.uid();
  account_count integer;
BEGIN
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  UPDATE public.accounts SET name = name WHERE user_id = owner_id;
  GET DIAGNOSTICS account_count = ROW_COUNT;
  RETURN account_count;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_owned_account_detection_rules() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sync_owned_account_detection_rules() TO authenticated;

-- Backfill existing accounts through the same trigger, preserving manual detection rules.
UPDATE public.accounts SET name = name;
