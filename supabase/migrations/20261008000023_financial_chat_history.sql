-- Save only reviewed model output and citation identifiers, never source snapshots.
CREATE TABLE public.financial_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 12000),
  insufficient_context boolean NOT NULL DEFAULT false,
  citation_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(citation_ids) <= 20)
);
CREATE INDEX financial_chat_history_owner_created ON public.financial_chat_history(user_id, created_at DESC, id);
ALTER TABLE public.financial_chat_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_chat_history FROM anon, authenticated;
GRANT SELECT, DELETE ON public.financial_chat_history TO authenticated;
GRANT ALL ON public.financial_chat_history TO service_role;
CREATE POLICY financial_chat_history_read ON public.financial_chat_history
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY financial_chat_history_delete ON public.financial_chat_history
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));
COMMENT ON TABLE public.financial_chat_history IS
  'Owner-only question and validated answer history. Delete permanently on request or account removal; never use prior messages as model instructions.';
