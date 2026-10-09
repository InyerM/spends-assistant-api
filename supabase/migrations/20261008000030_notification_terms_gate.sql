-- Notifications were introduced after the legal migration's table inventory.
-- Preserve the existing owner policy and enforce terms on both direct access and definer RPCs.
CREATE POLICY terms_acceptance_required ON public.owner_notifications
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.has_accepted_required_terms()))
  WITH CHECK ((SELECT public.has_accepted_required_terms()));
CREATE TRIGGER terms_acceptance_before_write
  BEFORE INSERT OR UPDATE ON public.owner_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_terms_before_owner_write();

CREATE OR REPLACE FUNCTION public.refresh_owner_notifications(p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_unread boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := auth.uid();
  v_month date := date_trunc('month', now() AT TIME ZONE 'America/Bogota')::date;
  v_verified boolean;
  v_pending integer := 0;
  v_warning integer := 0;
  v_data jsonb;
  v_unread integer;
  v_total integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_offset IS NULL OR p_offset < 0 OR p_unread IS NULL THEN
    RAISE EXCEPTION 'Invalid notification pagination' USING ERRCODE = '22023';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.email_forwarding_routes r WHERE r.user_id = v_user
    AND r.confirmation_received_at IS NOT NULL AND r.user_confirmed_at IS NOT NULL)
    INTO v_verified;
  IF v_verified THEN
    INSERT INTO public.owner_notifications(user_id, notice_key, kind, source_id, label, created_at)
      SELECT v_user, 'email:' || i.id, 'email_received', i.id,
        public.notification_email_excerpt(i.raw_text), i.received_at
      FROM public.shortcut_inbox_items i WHERE i.user_id = v_user AND i.source = 'forwarded_email'
      ON CONFLICT (user_id, notice_key) DO NOTHING;
    SELECT count(*)::integer INTO v_pending FROM public.shortcut_inbox_items i
      WHERE i.user_id = v_user AND i.source = 'forwarded_email' AND i.status = 'pending';
  END IF;
  INSERT INTO public.owner_notifications(user_id, notice_key, kind, source_id, label)
    SELECT v_user, 'budget:' || b.budget_id || ':' || v_month || ':' || b.threshold,
      CASE WHEN b.threshold = '100' THEN 'budget_exceeded' ELSE 'budget_near' END,
      b.budget_id, c.name
    FROM public.get_monthly_budget_status(v_month) b
    JOIN public.categories c ON c.id = b.category_id AND c.user_id = v_user
    WHERE b.threshold IN ('80', '100')
    ON CONFLICT (user_id, notice_key) DO NOTHING;
  SELECT count(*)::integer INTO v_warning FROM public.get_monthly_budget_status(v_month) b
    WHERE b.threshold IN ('80', '100');
  SELECT count(*)::integer INTO v_unread FROM public.owner_notifications n
    WHERE n.user_id = v_user AND n.read_at IS NULL AND (v_verified OR n.kind <> 'email_received');
  SELECT count(*)::integer INTO v_total FROM public.owner_notifications n
    WHERE n.user_id = v_user AND (v_verified OR n.kind <> 'email_received')
      AND (NOT p_unread OR n.read_at IS NULL);
  SELECT coalesce(jsonb_agg(to_jsonb(n) - 'user_id' - 'notice_key' ORDER BY n.created_at DESC, n.id), '[]'::jsonb)
    INTO v_data FROM (SELECT * FROM public.owner_notifications o WHERE o.user_id = v_user
      AND (v_verified OR o.kind <> 'email_received') AND (NOT p_unread OR o.read_at IS NULL)
      ORDER BY o.created_at DESC, o.id LIMIT p_limit OFFSET p_offset) n;
  RETURN jsonb_build_object('data', v_data, 'unread_count', v_unread,
    'total_count', v_total, 'pending_email_count', v_pending, 'budget_warning_count', v_warning);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_owner_notifications_read(p_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := auth.uid(); v_count integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000'; END IF;
  IF NOT public.has_accepted_required_terms() THEN
    RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.owner_notifications SET read_at = now()
    WHERE user_id = v_user AND read_at IS NULL AND (p_id IS NULL OR id = p_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_owner_notifications(integer, integer, boolean) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.mark_owner_notifications_read(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_owner_notifications(integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_owner_notifications_read(uuid) TO authenticated;
