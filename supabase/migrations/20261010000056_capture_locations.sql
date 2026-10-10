-- Optional owner-supplied capture coordinates, separate from merchant verification.
CREATE FUNCTION public.valid_capture_location(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE stamp timestamptz;
BEGIN
 IF value IS NULL THEN RETURN true;END IF;
 IF jsonb_typeof(value)<>'object' OR octet_length(value::text)>512 OR jsonb_typeof(value->'latitude') IS DISTINCT FROM 'number' OR jsonb_typeof(value->'longitude') IS DISTINCT FROM 'number' OR jsonb_typeof(value->'captured_at') IS DISTINCT FROM 'string' OR (value->>'latitude')::numeric NOT BETWEEN -90 AND 90 OR (value->>'longitude')::numeric NOT BETWEEN -180 AND 180 OR value->>'captured_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' THEN RETURN false;END IF;
 stamp:=(value->>'captured_at')::timestamptz;RETURN extract(year FROM stamp) BETWEEN 1900 AND 2100;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;$$;
ALTER TABLE public.shortcut_inbox_items ADD COLUMN capture_location jsonb CHECK(public.valid_capture_location(capture_location));
CREATE FUNCTION public.get_purchase_locations(p_limit integer DEFAULT 100,p_offset integer DEFAULT 0)
RETURNS TABLE(transaction_id uuid,inbox_item_id uuid,date date,amount numeric,currency text,description text,latitude double precision,longitude double precision,captured_at timestamptz,total_count bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE owner uuid:=auth.uid();
BEGIN
 IF owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='28000';END IF;
 IF NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Terms acceptance required' USING ERRCODE='42501';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'Invalid location page' USING ERRCODE='22023';END IF;
 RETURN QUERY WITH captures AS (
  SELECT DISTINCT ON(t.id) t.id AS tx,i.id AS inbox,t.date AS day,t.amount AS value,a.currency::text AS code,t.description::text AS label,(i.capture_location->>'latitude')::double precision AS lat,(i.capture_location->>'longitude')::double precision AS lon,(i.capture_location->>'captured_at')::timestamptz AS stamp
  FROM public.shortcut_inbox_items i JOIN public.shortcut_inbox_match_decisions d ON d.inbox_item_id=i.id AND d.user_id=i.user_id JOIN public.transactions t ON t.id=d.transaction_id AND t.user_id=d.user_id JOIN public.accounts a ON a.id=t.account_id AND a.user_id=t.user_id
  WHERE i.user_id=owner AND i.status IN('created','matched') AND i.capture_location IS NOT NULL AND t.type='expense' AND t.deleted_at IS NULL
  ORDER BY t.id,(i.capture_location->>'captured_at')::timestamptz DESC,i.id
 ) SELECT c.tx,c.inbox,c.day,c.value,c.code,c.label,c.lat,c.lon,c.stamp,count(*) OVER() FROM captures c ORDER BY c.stamp DESC,c.tx LIMIT p_limit OFFSET p_offset;
END;$$;
REVOKE ALL ON FUNCTION public.get_purchase_locations(integer,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_purchase_locations(integer,integer) TO authenticated;
