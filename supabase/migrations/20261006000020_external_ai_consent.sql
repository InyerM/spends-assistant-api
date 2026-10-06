CREATE TABLE public.ai_consent_decisions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('financial_text', 'document_images', 'forwarded_email')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 80),
  granted_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (user_id, scope),
  CHECK ((granted_at IS NOT NULL) <> (revoked_at IS NOT NULL))
);

ALTER TABLE public.ai_consent_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_consent_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_consent_decisions_select_owner ON public.ai_consent_decisions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY ai_consent_decisions_service_role ON public.ai_consent_decisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.ai_consent_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_consent_decisions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_consent_decisions TO service_role;
