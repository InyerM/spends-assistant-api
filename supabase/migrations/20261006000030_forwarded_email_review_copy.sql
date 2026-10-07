-- Suggestions are editable review data; financial posting remains owner-confirmed.
ALTER TABLE public.forwarded_email_analyses
  ADD COLUMN analysis_version smallint NOT NULL DEFAULT 1
    CHECK (analysis_version BETWEEN 1 AND 2),
  ADD COLUMN suggested_type text CHECK (suggested_type IN ('expense', 'income')),
  ADD COLUMN description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 150),
  ADD COLUMN notes text CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 500);

CREATE POLICY forwarded_email_analyses_update_owner ON public.forwarded_email_analyses
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id AND EXISTS (
    SELECT 1 FROM public.shortcut_inbox_items item
    WHERE item.id = inbox_item_id AND item.user_id = user_id AND item.status = 'pending'
  ))
  WITH CHECK ((SELECT auth.uid()) = user_id AND EXISTS (
    SELECT 1 FROM public.shortcut_inbox_items item
    WHERE item.id = inbox_item_id AND item.user_id = user_id AND item.status = 'pending'
  ));

GRANT UPDATE (analysis_version, suggested_type, description, notes, account_id,
  category_id, category_source) ON public.forwarded_email_analyses TO authenticated;
