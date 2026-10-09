-- Explanations are advisory and isolated from executable rule/sync state.
CREATE TABLE public.automation_rule_explanations (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  locale text NOT NULL CHECK (locale IN ('en', 'es', 'pt')),
  explanation text NOT NULL CHECK (char_length(explanation) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint, locale)
);
ALTER TABLE public.automation_rule_explanations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_rule_explanations FROM anon, authenticated;
GRANT SELECT ON public.automation_rule_explanations TO authenticated;
GRANT ALL ON public.automation_rule_explanations TO service_role;
CREATE POLICY automation_explanation_owner_read ON public.automation_rule_explanations
  FOR SELECT TO authenticated USING (user_id = auth.uid());
