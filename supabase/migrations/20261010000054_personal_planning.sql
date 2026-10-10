-- Owner planning remains separate from audited financial posting.
CREATE TABLE public.savings_goals (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),
 currency text NOT NULL CHECK(currency IN ('COP','USD')),
 target_amount numeric(15,2) NOT NULL CHECK(target_amount>0),
 saved_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK(saved_amount>=0), due_date date,
 is_active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.planned_expenses (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100), amount numeric(15,2) NOT NULL CHECK(amount>0),
 account_id uuid NOT NULL REFERENCES public.accounts(id), category_id uuid REFERENCES public.categories(id),
 cadence text NOT NULL CHECK(cadence IN ('monthly','days')), interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 366),
 month_day integer NOT NULL CHECK(month_day BETWEEN 1 AND 31), next_due date NOT NULL,
 due_time time NOT NULL DEFAULT '09:00', timezone text NOT NULL DEFAULT 'America/Bogota',
 automatic boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
 last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planned_expenses_due ON public.planned_expenses(next_due) WHERE is_active;
CREATE TABLE public.common_expenses (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100),amount numeric(15,2) NOT NULL CHECK(amount>0),
 account_id uuid NOT NULL REFERENCES public.accounts(id),category_id uuid REFERENCES public.categories(id),
 is_active boolean NOT NULL DEFAULT true,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.product_preferences (
 user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<8192),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.planning_commands (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,request_id uuid NOT NULL,
 payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,request_id)
);
CREATE TABLE public.planned_expense_postings (
 schedule_id uuid NOT NULL REFERENCES public.planned_expenses(id) ON DELETE CASCADE,
 due_date date NOT NULL,transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(schedule_id,due_date)
);
ALTER TABLE public.savings_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planned_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.common_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planning_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planned_expense_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY savings_owner ON public.savings_goals FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY planned_owner ON public.planned_expenses FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY common_owner ON public.common_expenses FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY preferences_owner ON public.product_preferences FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY commands_owner ON public.planning_commands FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY postings_owner ON public.planned_expense_postings FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.planned_expenses e WHERE e.id=schedule_id AND e.user_id=auth.uid()));
REVOKE ALL ON public.savings_goals,public.planned_expenses,public.common_expenses,public.product_preferences,public.planning_commands,public.planned_expense_postings FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.savings_goals,public.planned_expenses,public.common_expenses,public.product_preferences,public.planning_commands,public.planned_expense_postings TO authenticated;
CREATE FUNCTION public.next_planned_date(p_date date,p_cadence text,p_days integer,p_day integer) RETURNS date
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN p_cadence='monthly' THEN
  (date_trunc('month',p_date)+interval '1 month')::date + (least(p_day,extract(day FROM date_trunc('month',p_date)+interval '2 months - 1 day')::int)-1)
 ELSE p_date+p_days END;
$$;
CREATE FUNCTION public.apply_planning_command(p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_user uuid:=auth.uid();v_id uuid;v_action text:=p_payload->>'action';v_prior public.planning_commands%ROWTYPE;v_result jsonb;v_account uuid;v_category uuid;v_amount numeric;v_target numeric;v_saved numeric;v_date date;v_exists_owner uuid;
BEGIN
 IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';END IF;
 IF NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR octet_length(p_payload::text)>8192 THEN RAISE EXCEPTION 'Invalid planning command' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('planning:'||v_user::text,0));
 SELECT * INTO v_prior FROM public.planning_commands WHERE user_id=v_user AND request_id=p_request_id;
 IF FOUND THEN IF v_prior.payload<>p_payload THEN RAISE EXCEPTION 'Request belongs to a different payload' USING ERRCODE='22023';END IF;RETURN v_prior.result;END IF;
 IF v_action='preferences' THEN
  IF jsonb_typeof(p_payload->'preferences') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid preferences' USING ERRCODE='22023';END IF;
  INSERT INTO public.product_preferences(user_id,payload) VALUES(v_user,p_payload->'preferences') ON CONFLICT(user_id) DO UPDATE SET payload=public.product_preferences.payload||excluded.payload,updated_at=now();
  v_result:=jsonb_build_object('saved',true);
 ELSIF v_action IN ('save_goal','save_schedule','save_common','archive_goal','archive_schedule','archive_common') THEN
  v_id:=(p_payload->>'id')::uuid;IF v_id IS NULL THEN RAISE EXCEPTION 'Missing planning id' USING ERRCODE='22023';END IF;
  SELECT user_id INTO v_exists_owner FROM (SELECT id,user_id FROM public.savings_goals UNION ALL SELECT id,user_id FROM public.planned_expenses UNION ALL SELECT id,user_id FROM public.common_expenses) items WHERE id=v_id LIMIT 1;
  IF v_exists_owner IS NOT NULL AND v_exists_owner<>v_user THEN RAISE EXCEPTION 'Planning item owner mismatch' USING ERRCODE='42501';END IF;
  IF v_action LIKE 'archive_%' THEN
   IF v_action='archive_goal' THEN UPDATE public.savings_goals SET is_active=false,updated_at=now() WHERE id=v_id AND user_id=v_user;
   ELSIF v_action='archive_schedule' THEN UPDATE public.planned_expenses SET is_active=false,updated_at=now() WHERE id=v_id AND user_id=v_user;
   ELSE UPDATE public.common_expenses SET is_active=false,updated_at=now() WHERE id=v_id AND user_id=v_user;END IF;
   IF NOT FOUND THEN RAISE EXCEPTION 'Planning item not found' USING ERRCODE='P0002';END IF;
  ELSIF v_action='save_goal' THEN
   v_target:=(p_payload->>'target_amount')::numeric;v_saved:=(p_payload->>'saved_amount')::numeric;
   IF v_target<>round(v_target,2) OR v_saved<>round(v_saved,2) THEN RAISE EXCEPTION 'Invalid goal precision' USING ERRCODE='22023';END IF;
   INSERT INTO public.savings_goals(id,user_id,name,currency,target_amount,saved_amount,due_date) VALUES(v_id,v_user,btrim(p_payload->>'name'),p_payload->>'currency',v_target,v_saved,nullif(p_payload->>'due_date','')::date)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,target_amount=excluded.target_amount,saved_amount=excluded.saved_amount,due_date=excluded.due_date,is_active=true,updated_at=now();
  ELSE
   v_account:=(p_payload->>'account_id')::uuid;v_category:=nullif(p_payload->>'category_id','')::uuid;v_amount:=(p_payload->>'amount')::numeric;
   IF v_amount<>round(v_amount,2) OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=v_account AND user_id=v_user AND is_active AND deleted_at IS NULL AND currency IN ('COP','USD')) THEN RAISE EXCEPTION 'Invalid amount or account owner' USING ERRCODE='42501';END IF;
   IF v_category IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.categories WHERE id=v_category AND (user_id=v_user OR user_id IS NULL) AND type='expense' AND is_active AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Invalid category owner' USING ERRCODE='42501';END IF;
   IF v_action='save_common' THEN
    INSERT INTO public.common_expenses(id,user_id,name,amount,account_id,category_id) VALUES(v_id,v_user,btrim(p_payload->>'name'),v_amount,v_account,v_category)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,amount=excluded.amount,account_id=excluded.account_id,category_id=excluded.category_id,is_active=true,updated_at=now();
   ELSE
    v_date:=(p_payload->>'next_due')::date;
    IF (p_payload->>'automatic')::boolean AND v_date<(now() AT TIME ZONE (p_payload->>'timezone'))::date THEN RAISE EXCEPTION 'Automatic schedules must start today or later' USING ERRCODE='22023';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_payload->>'timezone') OR jsonb_typeof(p_payload->'automatic') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid schedule timezone or consent' USING ERRCODE='22023';END IF;
    INSERT INTO public.planned_expenses(id,user_id,name,amount,account_id,category_id,cadence,interval_days,month_day,next_due,due_time,timezone,automatic)
    VALUES(v_id,v_user,btrim(p_payload->>'name'),v_amount,v_account,v_category,p_payload->>'cadence',(p_payload->>'interval_days')::int,extract(day FROM v_date)::int,v_date,(p_payload->>'due_time')::time,p_payload->>'timezone',(p_payload->>'automatic')::boolean)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,amount=excluded.amount,account_id=excluded.account_id,category_id=excluded.category_id,cadence=excluded.cadence,interval_days=excluded.interval_days,month_day=CASE WHEN public.planned_expenses.next_due=excluded.next_due AND public.planned_expenses.cadence=excluded.cadence THEN public.planned_expenses.month_day ELSE excluded.month_day END,next_due=excluded.next_due,due_time=excluded.due_time,timezone=excluded.timezone,automatic=excluded.automatic,is_active=true,last_error=NULL,updated_at=now();
   END IF;
  END IF;
  v_result:=jsonb_build_object('id',v_id);
 ELSE RAISE EXCEPTION 'Unknown planning action' USING ERRCODE='22023';END IF;
 INSERT INTO public.planning_commands(user_id,request_id,payload,result) VALUES(v_user,p_request_id,p_payload,v_result);
 RETURN v_result;
END;$$;
REVOKE ALL ON FUNCTION public.apply_planning_command(uuid,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.apply_planning_command(uuid,jsonb) TO authenticated;
