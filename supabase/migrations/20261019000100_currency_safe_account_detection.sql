-- Legacy alias rules cannot establish a posting currency. USD requires explicit account review.
CREATE OR REPLACE FUNCTION public.sync_account_detection_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  suffix text;
  suffixes text[] := '{}';
  keywords text[];
BEGIN
  IF NEW.currency='COP' AND NEW.is_active AND NEW.deleted_at IS NULL AND NEW.type <> 'cash' THEN
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

UPDATE public.accounts SET name=name WHERE currency IS DISTINCT FROM 'COP';
