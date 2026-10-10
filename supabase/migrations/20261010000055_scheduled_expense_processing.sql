-- Only the trusted scheduler may execute opt-in recurring ledger postings.
ALTER TABLE public.owner_notifications DROP CONSTRAINT IF EXISTS owner_notifications_kind_check;
ALTER TABLE public.owner_notifications ADD CONSTRAINT owner_notifications_kind_check CHECK(kind IN('email_received','budget_near','budget_exceeded','goal_near','goal_reached','scheduled_due','scheduled_posted','scheduled_review'));
CREATE FUNCTION public.process_planned_expenses(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e public.planned_expenses%ROWTYPE;v_result jsonb;v_request uuid;v_tx uuid;v_count integer:=0;v_prior_sub text:=current_setting('request.jwt.claim.sub',true);v_error text;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'Invalid processing limit' USING ERRCODE='22023';END IF;
 INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label)
 SELECT user_id,'goal:'||id||':'||CASE WHEN saved_amount>=target_amount THEN '100' ELSE '80' END,
 CASE WHEN saved_amount>=target_amount THEN 'goal_reached' ELSE 'goal_near' END,id,name FROM public.savings_goals WHERE is_active AND saved_amount>=target_amount*0.8 ON CONFLICT(user_id,notice_key) DO NOTHING;
 INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label)
 SELECT user_id,'scheduled:due:'||id||':'||next_due,'scheduled_due',id,name FROM public.planned_expenses
 WHERE is_active AND next_due<=(now() AT TIME ZONE timezone)::date+1 ON CONFLICT(user_id,notice_key) DO NOTHING;
 FOR e IN SELECT * FROM public.planned_expenses WHERE is_active AND automatic AND (next_due+due_time) AT TIME ZONE timezone<=now() ORDER BY next_due,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   PERFORM set_config('request.jwt.claim.sub',e.user_id::text,true);
   IF NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE='42501';END IF;
   v_request:=md5('planned:'||e.id||':'||e.next_due)::uuid;
   v_result:=public.confirm_manual_transaction(v_request,jsonb_build_object('date',e.next_due::text,'time',e.due_time::text,'amount',e.amount,'description',e.name,'account_id',e.account_id,'category_id',e.category_id,'type','expense','source','scheduled','parsed_data',jsonb_build_object('schedule_id',e.id,'scheduled_date',e.next_due)),false,NULL);
   IF v_result->>'status'<>'created' OR v_result->'transaction'->>'id' IS NULL THEN RAISE EXCEPTION 'Scheduled transaction requires duplicate review' USING ERRCODE='23505';END IF;
   v_tx:=(v_result->'transaction'->>'id')::uuid;
   INSERT INTO public.planned_expense_postings(schedule_id,due_date,transaction_id) VALUES(e.id,e.next_due,v_tx) ON CONFLICT(schedule_id,due_date) DO NOTHING;
   UPDATE public.planned_expenses SET next_due=public.next_planned_date(e.next_due,e.cadence,e.interval_days,e.month_day),last_error=NULL,updated_at=now() WHERE id=e.id;
   INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label) VALUES(e.user_id,'scheduled:posted:'||e.id||':'||e.next_due,'scheduled_posted',e.id,e.name) ON CONFLICT(user_id,notice_key) DO NOTHING;
   v_count:=v_count+1;
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS v_error=RETURNED_SQLSTATE;
   UPDATE public.planned_expenses SET automatic=false,last_error=v_error,updated_at=now() WHERE id=e.id;
   INSERT INTO public.owner_notifications(user_id,notice_key,kind,source_id,label) VALUES(e.user_id,'scheduled:review:'||e.id||':'||e.next_due,'scheduled_review',e.id,e.name) ON CONFLICT(user_id,notice_key) DO NOTHING;
  END;
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_prior_sub,''),true);
 END LOOP;
 RETURN jsonb_build_object('posted',v_count);
END;$$;
REVOKE ALL ON FUNCTION public.process_planned_expenses(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_planned_expenses(integer) TO service_role;
