-- Private Shortcut backfill inbox. Intake and review do not create transactions.
CREATE TABLE public.shortcut_inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{1,39}$'),
  external_id TEXT CHECK (external_id IS NULL OR (length(external_id) BETWEEN 1 AND 256 AND btrim(external_id) <> '')),
  received_at TIMESTAMPTZ NOT NULL,
  raw_text TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 4096 AND btrim(raw_text) <> ''),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'non_transaction', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_inbox_user_key_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX shortcut_inbox_user_created_idx
  ON public.shortcut_inbox_items (user_id, created_at DESC, id DESC);
CREATE INDEX shortcut_inbox_user_status_idx
  ON public.shortcut_inbox_items (user_id, status, created_at DESC);
CREATE UNIQUE INDEX shortcut_inbox_user_external_id_unique
  ON public.shortcut_inbox_items (user_id, source, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX shortcut_inbox_user_fallback_unique
  ON public.shortcut_inbox_items (
    user_id, source, received_at,
    md5(lower(regexp_replace(btrim(raw_text), '[[:space:]]+', ' ', 'g')))
  ) WHERE external_id IS NULL;

CREATE FUNCTION public.prevent_shortcut_inbox_content_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
    OR NEW.raw_text IS DISTINCT FROM OLD.raw_text
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Inbox identity and content are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shortcut_inbox_content_immutable
  BEFORE UPDATE ON public.shortcut_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_shortcut_inbox_content_update();
CREATE TRIGGER shortcut_inbox_updated_at
  BEFORE UPDATE ON public.shortcut_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.shortcut_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shortcut_inbox_items FORCE ROW LEVEL SECURITY;

CREATE POLICY shortcut_inbox_select_owner ON public.shortcut_inbox_items
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY shortcut_inbox_insert_owner ON public.shortcut_inbox_items
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY shortcut_inbox_update_owner ON public.shortcut_inbox_items
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

REVOKE ALL ON public.shortcut_inbox_items FROM anon;
GRANT SELECT, INSERT ON public.shortcut_inbox_items TO authenticated;
GRANT UPDATE (status) ON public.shortcut_inbox_items TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.shortcut_inbox_items TO service_role;
