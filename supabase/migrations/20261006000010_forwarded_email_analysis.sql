-- Owner-visible suggestions remain separate from reviewed financial posting.
CREATE TABLE public.forwarded_email_analyses (
  inbox_item_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('parsed', 'needs_review')),
  merchant text CHECK (merchant IS NULL OR length(merchant) BETWEEN 2 AND 100),
  amount numeric(15,2) CHECK (amount IS NULL OR amount > 0),
  bank_event_at timestamptz,
  card_last_four text CHECK (card_last_four IS NULL OR card_last_four ~ '^\d{4}$'),
  account_id uuid,
  category_id uuid,
  category_source text CHECK (category_source IS NULL OR category_source IN ('catalog', 'ai')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items(id, user_id) ON DELETE CASCADE,
  CHECK ((category_id IS NULL) = (category_source IS NULL)),
  CHECK (status <> 'parsed' OR (merchant IS NOT NULL AND amount IS NOT NULL
    AND bank_event_at IS NOT NULL AND card_last_four IS NOT NULL))
);

CREATE INDEX forwarded_email_analyses_user_created_idx
  ON public.forwarded_email_analyses(user_id, created_at DESC);

ALTER TABLE public.forwarded_email_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forwarded_email_analyses FORCE ROW LEVEL SECURITY;

CREATE POLICY forwarded_email_analyses_select_owner ON public.forwarded_email_analyses
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY forwarded_email_analyses_insert_owner ON public.forwarded_email_analyses
  FOR INSERT TO authenticated WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.shortcut_inbox_items item
      WHERE item.id = inbox_item_id AND item.user_id = user_id
        AND item.source = 'forwarded_email' AND item.status = 'pending'
    )
  );

REVOKE ALL ON public.forwarded_email_analyses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.forwarded_email_analyses TO authenticated;
GRANT SELECT, INSERT ON public.forwarded_email_analyses TO service_role;
