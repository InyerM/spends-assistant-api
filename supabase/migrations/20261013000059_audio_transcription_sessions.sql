-- Metadata only: never store audio or transcripts. Four provider calls share one quota unit.
CREATE TABLE public.audio_transcription_sessions (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL,
 next_sequence integer NOT NULL,
 closed boolean NOT NULL DEFAULT false,
 used integer NOT NULL,
 quota_limit integer NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '150 seconds',
 PRIMARY KEY(user_id,session_id)
);
CREATE INDEX audio_transcription_expiry ON public.audio_transcription_sessions(expires_at);
ALTER TABLE public.audio_transcription_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_transcription_sessions FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.reserve_audio_transcription(p_user_id uuid,p_session_id uuid,p_sequence integer,p_final boolean)
RETURNS TABLE(allowed boolean,used integer,"limit" integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_session public.audio_transcription_sessions%ROWTYPE; v_quota record;
BEGIN
 IF p_user_id IS NULL OR p_session_id IS NULL OR p_sequence IS NULL OR p_sequence NOT BETWEEN 0 AND 3 OR p_final IS NULL OR (p_sequence=3 AND NOT p_final) THEN RAISE EXCEPTION 'Invalid audio session' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('audio:'||p_user_id::text||':'||p_session_id::text,0));
 SELECT * INTO v_session FROM public.audio_transcription_sessions WHERE user_id=p_user_id AND session_id=p_session_id FOR UPDATE;
 IF FOUND THEN
  IF v_session.closed OR v_session.expires_at<now() OR v_session.next_sequence<>p_sequence THEN RAISE EXCEPTION 'Audio session expired or out of sequence' USING ERRCODE='22023';END IF;
  UPDATE public.audio_transcription_sessions SET next_sequence=p_sequence+1,closed=p_final WHERE user_id=p_user_id AND session_id=p_session_id;
  RETURN QUERY SELECT true,v_session.used,v_session.quota_limit;
 ELSE
  IF p_sequence<>0 THEN RAISE EXCEPTION 'Audio session must begin at zero' USING ERRCODE='22023';END IF;
  SELECT * INTO v_quota FROM public.reserve_ai_parse(p_user_id);
  IF v_quota.allowed THEN
   INSERT INTO public.audio_transcription_sessions(user_id,session_id,next_sequence,closed,used,quota_limit) VALUES(p_user_id,p_session_id,1,p_final,v_quota.used,v_quota."limit");
  END IF;
  DELETE FROM public.audio_transcription_sessions WHERE (user_id,session_id) IN (SELECT s.user_id,s.session_id FROM public.audio_transcription_sessions s WHERE s.expires_at<now()-interval '1 day' LIMIT 100);
  RETURN QUERY SELECT v_quota.allowed,v_quota.used,v_quota."limit";
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.reserve_audio_transcription(uuid,uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_audio_transcription(uuid,uuid,integer,boolean) TO service_role;
