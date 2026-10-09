-- Forwarded PDF evidence keeps a server-owned, owner-scoped link to its original mail.
ALTER TABLE public.documents
  ADD COLUMN source_inbox_item_id uuid,
  ADD COLUMN email_attachment_key text,
  ADD CONSTRAINT documents_email_source_owner_fk
    FOREIGN KEY (source_inbox_item_id, user_id)
    REFERENCES public.shortcut_inbox_items(id, user_id),
  ADD CONSTRAINT documents_email_attachment_pair
    CHECK ((source_inbox_item_id IS NULL) = (email_attachment_key IS NULL)),
  ADD CONSTRAINT documents_email_attachment_key_format
    CHECK (email_attachment_key IS NULL OR email_attachment_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT documents_email_attachment_owner_key UNIQUE(user_id, email_attachment_key);
CREATE INDEX documents_email_source_owner ON public.documents(user_id, source_inbox_item_id)
  WHERE source_inbox_item_id IS NOT NULL;

CREATE FUNCTION public.guard_email_attachment_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.source_inbox_item_id IS DISTINCT FROM NEW.source_inbox_item_id OR
    OLD.email_attachment_key IS DISTINCT FROM NEW.email_attachment_key
  ) THEN
    RAISE EXCEPTION 'Attachment provenance is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.source_inbox_item_id IS NOT NULL
    AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Server-owned attachment provenance' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_email_provenance_guard BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.guard_email_attachment_provenance();
