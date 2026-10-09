-- Email dismissal archives evidence atomically; financial posting remains independent.
CREATE TABLE public.email_document_discard_archives (
  document_id uuid PRIMARY KEY,
  inbox_item_id uuid NOT NULL,
  user_id uuid NOT NULL,
  archived_at timestamptz NOT NULL,
  FOREIGN KEY (document_id,user_id) REFERENCES public.documents(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (inbox_item_id,user_id) REFERENCES public.shortcut_inbox_items(id,user_id) ON DELETE CASCADE
);
CREATE INDEX email_document_discard_owner_inbox ON public.email_document_discard_archives(user_id,inbox_item_id);
ALTER TABLE public.email_document_discard_archives ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_document_discard_owner_read ON public.email_document_discard_archives
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
REVOKE ALL ON public.email_document_discard_archives FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.email_document_discard_archives TO authenticated;

CREATE FUNCTION public.sync_dismissed_email_documents()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE v_document record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'dismissed' OR (OLD.status = 'dismissed' AND NEW.status = 'pending') THEN
    IF auth.uid() IS DISTINCT FROM NEW.user_id THEN
      RAISE EXCEPTION 'Email review requires the authenticated owner' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'dismissed' THEN
      FOR v_document IN SELECT id FROM public.documents
        WHERE user_id = NEW.user_id AND source_inbox_item_id = NEW.id AND archived_at IS NULL
        ORDER BY id FOR UPDATE
      LOOP
        PERFORM public.set_document_archived(v_document.id,true);
        INSERT INTO public.email_document_discard_archives(document_id,inbox_item_id,user_id,archived_at)
          SELECT id,NEW.id,user_id,archived_at FROM public.documents WHERE id = v_document.id
          ON CONFLICT (document_id) DO UPDATE SET archived_at = EXCLUDED.archived_at;
      END LOOP;
    ELSE
      FOR v_document IN SELECT d.id FROM public.documents d
        JOIN public.email_document_discard_archives a ON a.document_id = d.id AND a.user_id = d.user_id
        WHERE a.user_id = NEW.user_id AND a.inbox_item_id = NEW.id AND d.archived_at = a.archived_at
        ORDER BY d.id FOR UPDATE OF d
      LOOP
        PERFORM public.set_document_archived(v_document.id,false);
      END LOOP;
      DELETE FROM public.email_document_discard_archives WHERE user_id = NEW.user_id AND inbox_item_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_dismissed_email_documents() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER shortcut_inbox_document_dismissal AFTER UPDATE OF status ON public.shortcut_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_dismissed_email_documents();

CREATE FUNCTION public.pending_document_count()
RETURNS bigint LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public,pg_temp AS $$
  SELECT count(*) FROM public.documents d
  WHERE d.user_id = (SELECT auth.uid()) AND d.archived_at IS NULL
    AND (d.status IN ('uploaded','processing','failed') OR EXISTS (
      SELECT 1 FROM public.document_observations o
      WHERE o.document_id = d.id AND o.user_id = d.user_id AND o.status = 'pending'
    ))
$$;
REVOKE ALL ON FUNCTION public.pending_document_count() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.pending_document_count() TO authenticated;
