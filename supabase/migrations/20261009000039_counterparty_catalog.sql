-- A contact catalog is review context, never financial posting authority.
CREATE TABLE public.counterparties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 identity_kind text NOT NULL CHECK(identity_kind IN ('account','nequi','payment_key','merchant')),
 identity_value text NOT NULL CHECK(length(identity_value) BETWEEN 1 AND 160),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
 custom_name text CHECK(length(custom_name) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,identity_kind,identity_value), UNIQUE(id,user_id)
);
CREATE TABLE public.transaction_counterparties (
 transaction_id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 FOREIGN KEY(transaction_id,user_id) REFERENCES public.transactions(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(contact_id,user_id) REFERENCES public.counterparties(id,user_id) ON DELETE CASCADE
);
CREATE INDEX transaction_counterparty_owner_contact ON public.transaction_counterparties(user_id,contact_id,transaction_id);
CREATE TABLE public.counterparty_scan_results (
 transaction_id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('found','no_evidence','ambiguous','internal_transfer')),
 scanned_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(transaction_id,user_id) REFERENCES public.transactions(id,user_id) ON DELETE CASCADE
);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['counterparties','transaction_counterparties','counterparty_scan_results'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
  EXECUTE format('CREATE POLICY owner_read ON public.%I FOR SELECT TO authenticated USING(user_id=(SELECT auth.uid()))',target);
  EXECUTE format('CREATE POLICY terms_acceptance_required ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING((SELECT public.has_accepted_required_terms())) WITH CHECK((SELECT public.has_accepted_required_terms()))',target);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',target);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated,service_role',target);
 END LOOP;
END $$;

CREATE FUNCTION public.counterparty_evidence(p_text text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE hit text[]; hits jsonb := '[]'; entry jsonb; merchant text;
BEGIN
 -- Full explicit destinations only. Four-digit suffixes never identify a contact.
 FOR hit IN SELECT regexp_matches(p_text,'\m(a (?:la )?cuenta|transfer to|destino)\s*\*?([0-9]{8,18})\M','gi') LOOP
  hits := hits || jsonb_build_array(jsonb_build_object('kind','account','value',hit[2],'name',hit[2]));
 END LOOP;
 IF p_text !~* '\mrecibiste\M' THEN
  FOR hit IN SELECT regexp_matches(p_text,'\ma (?:la )?(nequi|llave)\s*\*?([[:alnum:]@._+-]{6,64})\M','gi') LOOP
   hits := hits || jsonb_build_array(jsonb_build_object('kind',CASE WHEN lower(hit[1])='nequi' THEN 'nequi' ELSE 'payment_key' END,'value',lower(hit[2]),'name',hit[2]));
  END LOOP;
 END IF;
 SELECT coalesce(jsonb_agg(value),'[]') INTO hits FROM (SELECT DISTINCT value FROM jsonb_array_elements(hits)) unique_hits;
 IF jsonb_array_length(hits)>1 THEN RETURN jsonb_build_object('status','ambiguous'); END IF;
 IF jsonb_array_length(hits)=1 THEN RETURN (hits->0)||jsonb_build_object('status','found'); END IF;
 hit := regexp_match(p_text,'(?:realizaste una )?compra(?:ste)?\s+(?:(?:COP|USD|\$)\s*[0-9.,]+\s+)?en\s+(.{2,160}?)(?:\s+por\s+\$|\s+con tu T\.|,\s*el\s+[0-9]{2}/)','i');
 IF hit IS NULL THEN hit := regexp_match(trim(p_text),'^compra en ([^\n\r<>]{2,100})$','i'); END IF;
 IF hit IS NOT NULL THEN merchant := trim(hit[1]); END IF;
 IF merchant IS NULL THEN
  hit := regexp_match(p_text,'recibiste una transferencia de (.{2,120}?) por\s+\$','i');
  IF hit IS NOT NULL AND hit[1] ~* '(S[.]?A[.]?S[.]?|L[.]?L[.]?C[.]?|LTD)\s*$' THEN merchant := trim(hit[1]); END IF;
 END IF;
 IF merchant IS NOT NULL AND merchant !~ '[\[\]<>\n]' THEN
  RETURN jsonb_build_object('status','found','kind','merchant','value',lower(regexp_replace(merchant,'\s+',' ','g')),'name',merchant);
 END IF;
 RETURN jsonb_build_object('status','no_evidence');
END $$;
REVOKE ALL ON FUNCTION public.counterparty_evidence(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.counterparty_evidence(text) TO authenticated,service_role;

CREATE FUNCTION public.sync_transaction_counterparty(p_transaction uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE movement public.transactions%ROWTYPE; evidence jsonb; contact uuid;
BEGIN
 SELECT * INTO movement FROM public.transactions WHERE id=p_transaction;
 IF NOT FOUND THEN RETURN; END IF;
 IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM movement.user_id THEN
  RAISE EXCEPTION 'Counterparty requires the authenticated owner' USING ERRCODE='42501';
 END IF;
 IF movement.deleted_at IS NOT NULL THEN
  DELETE FROM public.transaction_counterparties WHERE transaction_id=p_transaction;
  DELETE FROM public.counterparty_scan_results WHERE transaction_id=p_transaction;
  RETURN;
 END IF;
 IF movement.transfer_id IS NOT NULL OR movement.transfer_to_account_id IS NOT NULL THEN
  evidence := jsonb_build_object('status','internal_transfer');
 ELSE
  evidence := public.counterparty_evidence(coalesce(movement.raw_text,'')||E'\n'||coalesce(movement.description,''));
 END IF;
 IF evidence->>'status'='found' THEN
  INSERT INTO public.counterparties(user_id,identity_kind,identity_value,display_name)
   VALUES(movement.user_id,evidence->>'kind',evidence->>'value',evidence->>'name')
   ON CONFLICT(user_id,identity_kind,identity_value) DO UPDATE SET display_name=EXCLUDED.display_name
   RETURNING id INTO contact;
  INSERT INTO public.transaction_counterparties(transaction_id,user_id,contact_id)
   VALUES(movement.id,movement.user_id,contact)
   ON CONFLICT(transaction_id) DO UPDATE SET contact_id=EXCLUDED.contact_id;
 ELSE DELETE FROM public.transaction_counterparties WHERE transaction_id=movement.id;
 END IF;
 INSERT INTO public.counterparty_scan_results(transaction_id,user_id,status)
  VALUES(movement.id,movement.user_id,evidence->>'status')
  ON CONFLICT(transaction_id) DO UPDATE SET status=EXCLUDED.status,scanned_at=now();
END $$;
REVOKE ALL ON FUNCTION public.sync_transaction_counterparty(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.transaction_counterparty_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN PERFORM public.sync_transaction_counterparty(NEW.id); RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.transaction_counterparty_changed() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER transaction_counterparty_capture AFTER INSERT OR UPDATE OF raw_text,description,deleted_at,transfer_id,transfer_to_account_id
 ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.transaction_counterparty_changed();

CREATE FUNCTION public.scan_counterparty_catalog(p_after uuid DEFAULT NULL,p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE owner uuid:=auth.uid(); movement record; last_id uuid; processed integer:=0;
BEGIN
 IF owner IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authenticated owner required' USING ERRCODE='42501'; END IF;
 IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'Invalid scan page size'; END IF;
 FOR movement IN SELECT id FROM public.transactions WHERE user_id=owner AND deleted_at IS NULL AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit LOOP
  PERFORM public.sync_transaction_counterparty(movement.id); last_id:=movement.id; processed:=processed+1;
 END LOOP;
 RETURN jsonb_build_object('processed',processed,'next',last_id,'has_more',EXISTS(SELECT 1 FROM public.transactions WHERE user_id=owner AND deleted_at IS NULL AND id>last_id));
END $$;
REVOKE ALL ON FUNCTION public.scan_counterparty_catalog(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.scan_counterparty_catalog(uuid,integer) TO authenticated;

CREATE FUNCTION public.rename_counterparty(p_contact uuid,p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authenticated owner required' USING ERRCODE='42501'; END IF;
 IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid contact name'; END IF;
 UPDATE public.counterparties SET custom_name=trim(p_name),updated_at=now() WHERE user_id=auth.uid() AND id=p_contact;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contact not found' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.rename_counterparty(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.rename_counterparty(uuid,text) TO authenticated;

CREATE FUNCTION public.list_counterparties(p_query text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH contacts AS (
  SELECT c.*,coalesce(c.custom_name,c.display_name) AS name,
    (SELECT count(*) FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id WHERE l.user_id=auth.uid() AND l.contact_id=c.id AND t.deleted_at IS NULL) AS movement_count,
    (SELECT max(t.date) FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id WHERE l.user_id=auth.uid() AND l.contact_id=c.id AND t.deleted_at IS NULL) AS last_activity
  FROM public.counterparties c WHERE c.user_id=auth.uid()
   AND position(lower(coalesce(p_query,'')) IN lower(coalesce(c.custom_name,c.display_name)||' '||c.identity_value))>0
 ), active AS (SELECT * FROM contacts WHERE movement_count>0), page AS (
  SELECT * FROM active ORDER BY last_activity DESC,name,id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),100)
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::jsonb),'count',(SELECT count(*) FROM active),'scan',jsonb_build_object(
  'total',(SELECT count(*) FROM public.transactions WHERE user_id=auth.uid() AND deleted_at IS NULL),
  'scanned',(SELECT count(*) FROM public.counterparty_scan_results s JOIN public.transactions t ON t.id=s.transaction_id AND t.user_id=s.user_id WHERE s.user_id=auth.uid() AND t.deleted_at IS NULL),
  'unresolved',(SELECT count(*) FROM public.counterparty_scan_results s JOIN public.transactions t ON t.id=s.transaction_id AND t.user_id=s.user_id WHERE s.user_id=auth.uid() AND t.deleted_at IS NULL AND s.status IN ('no_evidence','ambiguous'))
  ));
$$;
REVOKE ALL ON FUNCTION public.list_counterparties(text,integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_counterparties(text,integer,integer) TO authenticated;

CREATE FUNCTION public.counterparty_detail(p_contact uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH movements AS (
  SELECT t.* FROM public.transaction_counterparties l JOIN public.transactions t ON t.id=l.transaction_id AND t.user_id=l.user_id
  WHERE l.user_id=auth.uid() AND l.contact_id=p_contact AND t.deleted_at IS NULL
 ), currencies AS (
  SELECT currency,count(*) AS count,sum(amount) FILTER(WHERE type='expense') AS expenses,sum(amount) FILTER(WHERE type='income') AS income FROM movements GROUP BY currency
 ), categories AS (SELECT m.category_id,c.name,c.translations,count(*) AS count FROM movements m LEFT JOIN public.categories c ON c.id=m.category_id AND c.user_id=auth.uid() GROUP BY m.category_id,c.name,c.translations), recent AS (
  SELECT id,date,description,amount,currency,type,category_id FROM movements ORDER BY date DESC,id LIMIT 100
 ) SELECT jsonb_build_object('contact',to_jsonb(c),'totals',coalesce((SELECT jsonb_agg(to_jsonb(currencies)) FROM currencies),'[]'::jsonb),'categories',coalesce((SELECT jsonb_agg(to_jsonb(categories)) FROM categories),'[]'::jsonb),'transactions',coalesce((SELECT jsonb_agg(to_jsonb(recent)) FROM recent),'[]'::jsonb),'movement_count',(SELECT count(*) FROM movements))
 FROM public.counterparties c WHERE c.id=p_contact AND c.user_id=auth.uid();
$$;
REVOKE ALL ON FUNCTION public.counterparty_detail(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.counterparty_detail(uuid) TO authenticated;
