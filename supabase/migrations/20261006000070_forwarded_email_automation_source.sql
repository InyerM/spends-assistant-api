ALTER TABLE public.forwarded_email_analyses
  DROP CONSTRAINT forwarded_email_analyses_category_source_check;

ALTER TABLE public.forwarded_email_analyses
  ADD CONSTRAINT forwarded_email_analyses_category_source_check
  CHECK (category_source IS NULL OR
    category_source IN ('catalog', 'ai', 'review_context', 'automation'));
