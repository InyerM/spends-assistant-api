-- Preserve discarded observations and captures so a reviewer can correct a decision.
ALTER TABLE public.documents ADD COLUMN archived_at timestamptz;
CREATE INDEX documents_owner_active_idx ON public.documents(user_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE public.document_observation_rejection_reasons (
  decision_id uuid PRIMARY KEY REFERENCES public.document_observation_decisions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN (
    'already_recorded', 'duplicate_capture', 'not_a_transaction',
    'unreadable', 'wrong_account', 'other'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.document_observation_rejection_reasons ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_rejection_reason_owner ON public.document_observation_rejection_reasons
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.document_observation_rejection_reasons FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.document_observation_rejection_reasons TO authenticated;
GRANT ALL ON public.document_observation_rejection_reasons TO service_role;

CREATE TABLE public.document_observation_restorations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_observation_restorations_owner_fk
    FOREIGN KEY (observation_id, user_id)
    REFERENCES public.document_observations(id, user_id) ON DELETE CASCADE
);
CREATE INDEX document_observation_restorations_owner_idx
  ON public.document_observation_restorations(user_id, observation_id, created_at DESC);
ALTER TABLE public.document_observation_restorations ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_restoration_owner ON public.document_observation_restorations
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.document_observation_restorations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.document_observation_restorations TO authenticated;
GRANT ALL ON public.document_observation_restorations TO service_role;

CREATE TABLE public.document_archive_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  archived boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_archive_events_owner_fk
    FOREIGN KEY (document_id, user_id) REFERENCES public.documents(id, user_id) ON DELETE CASCADE
);
CREATE INDEX document_archive_events_owner_idx
  ON public.document_archive_events(user_id, document_id, created_at DESC);
ALTER TABLE public.document_archive_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_archive_events_owner ON public.document_archive_events
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.document_archive_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.document_archive_events TO authenticated;
GRANT ALL ON public.document_archive_events TO service_role;

CREATE OR REPLACE FUNCTION public.guard_reviewed_observation_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'rejected' AND NEW.status = 'pending'
    AND OLD.match_transaction_id IS NULL AND NEW.match_transaction_id IS NULL
    AND current_setting('app.document_restore_observation', true) = OLD.id::text THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('confirmed', 'rejected') AND
    (NEW.status, NEW.match_transaction_id) IS DISTINCT FROM
    (OLD.status, OLD.match_transaction_id) THEN
    RAISE EXCEPTION 'Reviewed observation links are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.decide_document_observation_with_reason(
  p_observation_id uuid, p_action text, p_transaction_id uuid,
  p_idempotency_key uuid, p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_decision_id uuid;
  v_existing_reason text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_action <> 'reject_observation' OR p_reason IS NULL OR p_reason NOT IN (
    'already_recorded', 'duplicate_capture', 'not_a_transaction',
    'unreadable', 'wrong_account', 'other'
  ) THEN
    RAISE EXCEPTION 'Invalid rejection reason' USING ERRCODE = '22023';
  END IF;
  v_decision_id := public.decide_document_observation(
    p_observation_id, p_action, p_transaction_id, p_idempotency_key
  );
  INSERT INTO public.document_observation_rejection_reasons(decision_id, user_id, reason)
  VALUES (v_decision_id, v_user, p_reason)
  ON CONFLICT (decision_id) DO NOTHING;
  SELECT reason INTO v_existing_reason FROM public.document_observation_rejection_reasons
  WHERE decision_id = v_decision_id AND user_id = v_user;
  IF v_existing_reason IS DISTINCT FROM p_reason THEN
    RAISE EXCEPTION 'Idempotency key reused for a different reason' USING ERRCODE = '23505';
  END IF;
  RETURN v_decision_id;
END;
$$;
REVOKE ALL ON FUNCTION public.decide_document_observation_with_reason(uuid,text,uuid,uuid,text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.decide_document_observation_with_reason(uuid,text,uuid,uuid,text)
  TO authenticated;

CREATE FUNCTION public.restore_document_observation(p_observation_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_observation record;
  v_restoration_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  SELECT o.id, o.status, o.match_transaction_id, d.status AS document_status,
    d.archived_at INTO v_observation
  FROM public.document_observations o
  JOIN public.documents d ON d.id = o.document_id AND d.user_id = o.user_id
  WHERE o.id = p_observation_id AND o.user_id = v_user FOR UPDATE OF o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Observation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_observation.status <> 'rejected' OR v_observation.match_transaction_id IS NOT NULL
    OR v_observation.document_status <> 'extracted' OR v_observation.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Observation cannot be restored' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('app.document_restore_observation', p_observation_id::text, true);
  UPDATE public.document_observations SET status = 'pending'
  WHERE id = p_observation_id AND user_id = v_user;
  INSERT INTO public.document_observation_restorations(user_id, observation_id)
  VALUES (v_user, p_observation_id) RETURNING id INTO v_restoration_id;
  RETURN v_restoration_id;
END;
$$;
REVOKE ALL ON FUNCTION public.restore_document_observation(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.restore_document_observation(uuid) TO authenticated;

CREATE FUNCTION public.set_document_archived(p_document_id uuid, p_archived boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user uuid := auth.uid();
  v_document record;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_archived IS NULL THEN
    RAISE EXCEPTION 'Invalid archive state' USING ERRCODE = '22023';
  END IF;
  SELECT id, archived_at INTO v_document FROM public.documents
  WHERE id = p_document_id AND user_id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_archived AND EXISTS (
    SELECT 1 FROM public.document_observations o
    JOIN public.transactions t ON t.user_id = o.user_id
      AND t.source = 'web-document' AND t.deleted_at IS NULL
      AND t.parsed_data->>'document_id' = o.document_id::text
      AND t.parsed_data->>'observation_id' = o.id::text
    WHERE o.document_id = p_document_id AND o.user_id = v_user
      AND o.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Document has a created transaction requiring link review'
      USING ERRCODE = '23514';
  END IF;
  IF (v_document.archived_at IS NOT NULL) IS DISTINCT FROM p_archived THEN
    UPDATE public.documents SET archived_at = CASE WHEN p_archived THEN now() ELSE NULL END
    WHERE id = p_document_id AND user_id = v_user;
    INSERT INTO public.document_archive_events(user_id, document_id, archived)
    VALUES (v_user, p_document_id, p_archived);
  END IF;
  RETURN p_archived;
END;
$$;
REVOKE ALL ON FUNCTION public.set_document_archived(uuid,boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_document_archived(uuid,boolean) TO authenticated;

CREATE FUNCTION public.guard_archived_document_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = NEW.document_id AND d.user_id = NEW.user_id AND d.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Archived document cannot be reviewed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_observations_archived_review_guard
  BEFORE UPDATE OF status ON public.document_observations
  FOR EACH ROW EXECUTE FUNCTION public.guard_archived_document_review();
