-- Existing accounts retain access; only accounts created after this migration require acceptance.
CREATE TABLE public.legal_acceptances (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, version)
);
ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;
CREATE POLICY legal_acceptances_owner_read ON public.legal_acceptances
  FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.legal_acceptances TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.legal_acceptances FROM authenticated, anon;

CREATE FUNCTION public.require_terms_for_new_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.raw_app_meta_data := coalesce(NEW.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('anotto_terms_required', true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.require_terms_for_new_account() FROM PUBLIC;
CREATE TRIGGER require_anotto_terms BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.require_terms_for_new_account();

CREATE FUNCTION public.has_accepted_required_terms() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = auth.uid()
    AND (coalesce(u.raw_app_meta_data->>'anotto_terms_required', 'false') <> 'true'
      OR EXISTS (SELECT 1 FROM public.legal_acceptances a
        WHERE a.user_id = u.id AND a.version = '2026-10-08'))
  );
$$;
REVOKE ALL ON FUNCTION public.has_accepted_required_terms() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_accepted_required_terms() TO authenticated;

CREATE FUNCTION public.accept_current_terms(p_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_version IS DISTINCT FROM '2026-10-08' THEN RAISE EXCEPTION 'Unsupported terms version'; END IF;
  INSERT INTO public.legal_acceptances(user_id, version) VALUES (auth.uid(), p_version)
    ON CONFLICT DO NOTHING;
  UPDATE auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('anotto_terms_version', p_version)
    WHERE id = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.accept_current_terms(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_current_terms(text) TO authenticated;

-- A restrictive policy composes with existing owner policies and cannot grant new access.
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname <> 'legal_acceptances'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attname = 'user_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('CREATE POLICY terms_acceptance_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.has_accepted_required_terms())) WITH CHECK ((SELECT public.has_accepted_required_terms()))', target.relname);
  END LOOP;
END;
$$;

-- SECURITY DEFINER posting functions still run table triggers. This closes direct RPC writes
-- without interfering with service jobs or the separately authorized account-deletion path.
CREATE FUNCTION public.enforce_terms_before_owner_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_terms_before_owner_write() FROM PUBLIC;
DO $$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname <> 'legal_acceptances'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
        AND a.attname = 'user_id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('CREATE TRIGGER terms_acceptance_before_write BEFORE INSERT OR UPDATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_terms_before_owner_write()', target.relname);
  END LOOP;
END;
$$;
