-- Content labels are independent of financial review and sender authentication.
ALTER TABLE public.shortcut_inbox_items
  ADD COLUMN message_kind text NOT NULL DEFAULT 'uncertain'
    CHECK (message_kind IN ('purchase','transfer','income','statement','financial_document','promotion','informational','security','spam','uncertain')),
  ADD COLUMN message_kind_source text NOT NULL DEFAULT 'unclassified'
    CHECK (message_kind_source IN ('unclassified','rules','ai','review')),
  ADD COLUMN message_classified_at timestamptz;
CREATE INDEX shortcut_email_kind_owner_received
  ON public.shortcut_inbox_items(user_id,message_kind,received_at DESC,id)
  WHERE source = 'forwarded_email';
