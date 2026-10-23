-- Durable suggestions only. These jobs never post transactions or change balances.
ALTER TABLE public.forwarded_email_analyses
  DROP CONSTRAINT forwarded_email_analyses_analysis_version_check,
  ADD CONSTRAINT forwarded_email_analyses_analysis_version_check CHECK (analysis_version BETWEEN 1 AND 3),
  ADD COLUMN analysis_details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(analysis_details) = 'object' AND octet_length(analysis_details::text) <= 16384);

CREATE TABLE public.inbox_analysis_jobs (
  inbox_item_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','ready','blocked','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text CHECK (last_error IN ('consent_required','quota_limit','unverified_source','provider_unavailable','invalid_source')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inbox_item_id,user_id) REFERENCES public.shortcut_inbox_items(id,user_id) ON DELETE CASCADE,
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND leased_until IS NOT NULL))
);
CREATE INDEX inbox_analysis_jobs_due ON public.inbox_analysis_jobs(available_at,created_at) WHERE state IN ('pending','failed','running');
ALTER TABLE public.inbox_analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_analysis_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_analysis_jobs_owner_read ON public.inbox_analysis_jobs FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON public.inbox_analysis_jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT(inbox_item_id,user_id,state,attempts,available_at,last_error,created_at,updated_at)
  ON public.inbox_analysis_jobs TO authenticated;
GRANT ALL ON public.inbox_analysis_jobs TO service_role;

CREATE FUNCTION public.request_inbox_analysis_job(p_inbox_item_id uuid,p_user_id uuid,p_force boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE item_status text; job_state text;
BEGIN
  SELECT status INTO item_status FROM public.shortcut_inbox_items
    WHERE id=p_inbox_item_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inbox item not found' USING ERRCODE='22023'; END IF;
  IF item_status <> 'pending' THEN RETURN 'skipped'; END IF;
  SELECT state INTO job_state FROM public.inbox_analysis_jobs
    WHERE inbox_item_id=p_inbox_item_id AND user_id=p_user_id FOR UPDATE;
  IF job_state='running' OR (job_state='ready' AND NOT p_force AND EXISTS(
    SELECT 1 FROM public.forwarded_email_analyses a WHERE a.inbox_item_id=p_inbox_item_id
      AND a.user_id=p_user_id AND a.analysis_version=3)) THEN RETURN job_state; END IF;
  INSERT INTO public.inbox_analysis_jobs(inbox_item_id,user_id)
    VALUES(p_inbox_item_id,p_user_id)
  ON CONFLICT(inbox_item_id) DO UPDATE SET state='pending',attempts=0,available_at=now(),
    lease_token=NULL,leased_until=NULL,last_error=NULL,updated_at=now();
  RETURN 'pending';
END $$;

CREATE FUNCTION public.enqueue_inbox_analysis_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF NEW.status='pending' THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO public.inbox_analysis_jobs(inbox_item_id,user_id) VALUES(NEW.id,NEW.user_id)
        ON CONFLICT(inbox_item_id) DO NOTHING;
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM public.request_inbox_analysis_job(NEW.id,NEW.user_id,true);
    END IF;
  ELSE
    UPDATE public.inbox_analysis_jobs SET state='skipped',lease_token=NULL,leased_until=NULL,updated_at=now()
      WHERE inbox_item_id=NEW.id AND user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shortcut_inbox_enqueue_analysis AFTER INSERT OR UPDATE OF status ON public.shortcut_inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_inbox_analysis_job();

CREATE FUNCTION public.claim_inbox_analysis_jobs(p_limit integer DEFAULT 5,p_inbox_item_id uuid DEFAULT NULL,p_user_id uuid DEFAULT NULL)
RETURNS TABLE(inbox_item_id uuid,user_id uuid,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE='22023'; END IF;
  -- Exhausted workers may crash without a failure acknowledgement; release their stale leases.
  WITH exhausted AS (
    SELECT j.inbox_item_id FROM public.inbox_analysis_jobs j
    WHERE j.state='running' AND j.attempts>=3 AND j.leased_until<=now()
      AND (p_inbox_item_id IS NULL OR j.inbox_item_id=p_inbox_item_id)
      AND (p_user_id IS NULL OR j.user_id=p_user_id)
    ORDER BY j.leased_until,j.inbox_item_id FOR UPDATE OF j SKIP LOCKED LIMIT 20
  ) UPDATE public.inbox_analysis_jobs j SET state='failed',lease_token=NULL,leased_until=NULL,
    last_error='provider_unavailable',updated_at=now() FROM exhausted e WHERE j.inbox_item_id=e.inbox_item_id;
  RETURN QUERY WITH candidates AS (
    SELECT j.inbox_item_id FROM public.inbox_analysis_jobs j
    JOIN public.shortcut_inbox_items i ON i.id=j.inbox_item_id AND i.user_id=j.user_id
    WHERE i.status='pending' AND j.attempts<3
      AND ((j.state IN ('pending','failed') AND j.available_at<=now()) OR (j.state='running' AND j.leased_until<=now()))
      AND (p_inbox_item_id IS NULL OR j.inbox_item_id=p_inbox_item_id)
      AND (p_user_id IS NULL OR j.user_id=p_user_id)
    ORDER BY j.available_at,j.created_at,j.inbox_item_id FOR UPDATE OF j SKIP LOCKED LIMIT p_limit
  ) UPDATE public.inbox_analysis_jobs j SET state='running',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),leased_until=now()+interval '2 minutes',last_error=NULL,updated_at=now()
    FROM candidates c WHERE j.inbox_item_id=c.inbox_item_id
    RETURNING j.inbox_item_id,j.user_id,j.lease_token;
END $$;

CREATE FUNCTION public.complete_inbox_analysis_job(p_inbox_item_id uuid,p_user_id uuid,p_lease_token uuid,p_analysis jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE item_status text; account uuid; category uuid; details jsonb; proposed_type text;
BEGIN
  SELECT status INTO item_status FROM public.shortcut_inbox_items WHERE id=p_inbox_item_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR item_status<>'pending' THEN RETURN false; END IF;
  PERFORM 1 FROM public.inbox_analysis_jobs WHERE inbox_item_id=p_inbox_item_id AND user_id=p_user_id
    AND state='running' AND lease_token=p_lease_token AND leased_until>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_analysis IS NULL OR jsonb_typeof(p_analysis)<>'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_analysis) k WHERE k NOT IN
    ('status','merchant','amount','bank_event_at','card_last_four','account_id','category_id','category_source','suggested_type','description','notes','analysis_details')) THEN
    RAISE EXCEPTION 'Invalid analysis fields' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(p_analysis) e WHERE
    (e.key NOT IN ('amount','analysis_details') AND jsonb_typeof(e.value) NOT IN ('string','null')) OR
    (e.key='amount' AND jsonb_typeof(e.value) NOT IN ('number','null'))) THEN
    RAISE EXCEPTION 'Invalid analysis field type' USING ERRCODE='22023'; END IF;
  details=coalesce(p_analysis->'analysis_details','{}'::jsonb);
  IF jsonb_typeof(details)<>'object' OR octet_length(details::text)>16384 THEN
    RAISE EXCEPTION 'Invalid analysis details' USING ERRCODE='22023'; END IF;
  account=(p_analysis->>'account_id')::uuid; category=(p_analysis->>'category_id')::uuid;
  proposed_type=p_analysis->>'suggested_type';
  IF account IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=account AND a.user_id=p_user_id AND a.is_active AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid analysis account' USING ERRCODE='22023'; END IF;
  IF category IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.categories c WHERE c.id=category AND c.user_id=p_user_id AND c.is_active AND c.deleted_at IS NULL AND (proposed_type IS NULL OR c.type=proposed_type)) THEN
    RAISE EXCEPTION 'Invalid analysis category' USING ERRCODE='22023'; END IF;
  INSERT INTO public.forwarded_email_analyses(inbox_item_id,user_id,status,merchant,amount,bank_event_at,card_last_four,account_id,category_id,category_source,analysis_version,suggested_type,description,notes,analysis_details)
  VALUES(p_inbox_item_id,p_user_id,coalesce(p_analysis->>'status','needs_review'),p_analysis->>'merchant',
    (p_analysis->>'amount')::numeric,(p_analysis->>'bank_event_at')::timestamptz,p_analysis->>'card_last_four',account,category,
    p_analysis->>'category_source',3,proposed_type,p_analysis->>'description',p_analysis->>'notes',details)
  ON CONFLICT(inbox_item_id) DO UPDATE SET status=excluded.status,merchant=excluded.merchant,amount=excluded.amount,
    bank_event_at=excluded.bank_event_at,card_last_four=excluded.card_last_four,account_id=excluded.account_id,
    category_id=excluded.category_id,category_source=excluded.category_source,analysis_version=3,
    suggested_type=excluded.suggested_type,description=excluded.description,notes=excluded.notes,analysis_details=excluded.analysis_details
    WHERE forwarded_email_analyses.user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Analysis owner mismatch' USING ERRCODE='22023'; END IF;
  UPDATE public.inbox_analysis_jobs SET state='ready',lease_token=NULL,leased_until=NULL,last_error=NULL,updated_at=now()
    WHERE inbox_item_id=p_inbox_item_id AND user_id=p_user_id;
  RETURN true;
END $$;

CREATE FUNCTION public.fail_inbox_analysis_job(p_inbox_item_id uuid,p_user_id uuid,p_lease_token uuid,p_reason text,p_retry_seconds integer DEFAULT 60,p_blocked boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE gate_resolved boolean := false; required_scope text;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('consent_required','quota_limit','unverified_source','provider_unavailable','invalid_source') THEN
    RAISE EXCEPTION 'Invalid analysis failure code' USING ERRCODE='22023'; END IF;
  SELECT CASE WHEN i.source='forwarded_email' THEN 'forwarded_email' ELSE 'financial_text' END
    INTO required_scope FROM public.shortcut_inbox_items i WHERE i.id=p_inbox_item_id AND i.user_id=p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Shared gate locks also cover first-time grants, where no existing row can be locked.
  IF p_blocked AND p_reason='consent_required' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('inbox-analysis-consent:'||p_user_id::text||':'||required_scope,0));
    SELECT EXISTS(SELECT 1 FROM public.ai_consent_decisions c WHERE c.user_id=p_user_id
      AND c.scope=required_scope AND c.version='external-ai-v1' AND c.granted_at IS NOT NULL AND c.revoked_at IS NULL)
      INTO gate_resolved;
  ELSIF p_blocked AND p_reason='unverified_source' AND required_scope='forwarded_email' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('inbox-analysis-verification:'||p_user_id::text,0));
    SELECT EXISTS(SELECT 1 FROM public.email_forwarding_routes r WHERE r.user_id=p_user_id
      AND r.confirmation_received_at IS NOT NULL AND r.user_confirmed_at IS NOT NULL) INTO gate_resolved;
  END IF;
  UPDATE public.inbox_analysis_jobs j SET state=CASE WHEN gate_resolved THEN 'pending' WHEN p_blocked THEN 'blocked' ELSE 'failed' END,
    attempts=CASE WHEN gate_resolved THEN 0 ELSE j.attempts END,
    available_at=CASE WHEN gate_resolved THEN now() ELSE now()+make_interval(secs=>greatest(60,least(coalesce(p_retry_seconds,60),3600))) END,
    last_error=CASE WHEN gate_resolved THEN NULL ELSE p_reason END,lease_token=NULL,leased_until=NULL,updated_at=now()
    WHERE j.inbox_item_id=p_inbox_item_id AND j.user_id=p_user_id AND j.state='running'
      AND j.lease_token=p_lease_token AND j.leased_until>now()
      AND EXISTS(SELECT 1 FROM public.shortcut_inbox_items i WHERE i.id=j.inbox_item_id AND i.user_id=j.user_id AND i.status='pending');
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_inbox_analysis_job() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.request_inbox_analysis_job(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_inbox_analysis_jobs(integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_inbox_analysis_job(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.fail_inbox_analysis_job(uuid,uuid,uuid,text,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_inbox_analysis_job(uuid,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbox_analysis_jobs(integer,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inbox_analysis_job(uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_inbox_analysis_job(uuid,uuid,uuid,text,integer,boolean) TO service_role;

-- Resume only jobs whose original blocker has just been resolved, never unrelated historical items.
CREATE FUNCTION public.resume_inbox_analysis_after_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF NEW.version<>'external-ai-v1' OR NEW.granted_at IS NULL OR NEW.revoked_at IS NOT NULL
    OR NEW.scope NOT IN ('financial_text','forwarded_email') THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('inbox-analysis-consent:'||NEW.user_id::text||':'||NEW.scope,0));
  IF TG_OP='UPDATE' THEN
    IF OLD.user_id=NEW.user_id AND OLD.scope=NEW.scope AND OLD.version=NEW.version
      AND OLD.granted_at IS NOT NULL AND OLD.revoked_at IS NULL THEN RETURN NEW; END IF;
  END IF;
  UPDATE public.inbox_analysis_jobs j SET state='pending',attempts=0,available_at=now(),
    lease_token=NULL,leased_until=NULL,last_error=NULL,updated_at=now()
  FROM public.shortcut_inbox_items i
  WHERE j.inbox_item_id=i.id AND j.user_id=i.user_id AND j.user_id=NEW.user_id
    AND j.state='blocked' AND j.last_error='consent_required' AND i.status='pending'
    AND ((NEW.scope='forwarded_email' AND i.source='forwarded_email')
      OR (NEW.scope='financial_text' AND i.source<>'forwarded_email'));
  RETURN NEW;
END $$;
CREATE TRIGGER ai_consent_resume_inbox_analysis
  AFTER INSERT OR UPDATE OF user_id,scope,version,granted_at,revoked_at ON public.ai_consent_decisions
  FOR EACH ROW EXECUTE FUNCTION public.resume_inbox_analysis_after_consent();
REVOKE ALL ON FUNCTION public.resume_inbox_analysis_after_consent() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.resume_inbox_analysis_after_forwarding_verification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
BEGIN
  IF NEW.confirmation_received_at IS NULL OR NEW.user_confirmed_at IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('inbox-analysis-verification:'||NEW.user_id::text,0));
  IF TG_OP='UPDATE' THEN
    IF OLD.user_id=NEW.user_id AND OLD.confirmation_received_at IS NOT NULL
      AND OLD.user_confirmed_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  UPDATE public.inbox_analysis_jobs j SET state='pending',attempts=0,available_at=now(),
    lease_token=NULL,leased_until=NULL,last_error=NULL,updated_at=now()
  FROM public.shortcut_inbox_items i
  WHERE j.inbox_item_id=i.id AND j.user_id=i.user_id AND j.user_id=NEW.user_id
    AND j.state='blocked' AND j.last_error='unverified_source' AND i.status='pending'
    AND i.source='forwarded_email';
  RETURN NEW;
END $$;
CREATE TRIGGER email_forwarding_resume_inbox_analysis
  AFTER INSERT OR UPDATE OF user_id,confirmation_received_at,user_confirmed_at ON public.email_forwarding_routes
  FOR EACH ROW EXECUTE FUNCTION public.resume_inbox_analysis_after_forwarding_verification();
REVOKE ALL ON FUNCTION public.resume_inbox_analysis_after_forwarding_verification() FROM PUBLIC,anon,authenticated;
