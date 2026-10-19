-- A stable owner-specific placeholder makes every unclassified posting filterable.
CREATE FUNCTION public.ensure_uncategorized_category(p_owner uuid,p_type text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_parent uuid; v_category uuid; v_slug text;
BEGIN
 IF p_type NOT IN ('expense','income') OR p_owner IS NULL THEN RETURN NULL; END IF;
 v_slug:=CASE WHEN p_type='expense' THEN 'uncategorized' ELSE 'uncategorized-income' END;
 SELECT id INTO v_category FROM public.categories WHERE user_id=p_owner AND slug=v_slug AND type=p_type AND is_active AND deleted_at IS NULL;
 IF v_category IS NOT NULL THEN RETURN v_category; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('default-category:'||p_owner::text||':'||p_type,0));
 SELECT id INTO v_parent FROM public.categories WHERE user_id=p_owner AND slug=CASE WHEN p_type='expense' THEN 'others' ELSE 'others-income' END AND type=p_type;
 IF v_parent IS NULL THEN
  INSERT INTO public.categories(user_id,name,slug,type,is_default,spending_nature,translations)
   VALUES(p_owner,'Others',CASE WHEN p_type='expense' THEN 'others' ELSE 'others-income' END,p_type,true,'none','{"en":"Others","es":"Otros","pt":"Outros"}') RETURNING id INTO v_parent;
 END IF;
 INSERT INTO public.categories(user_id,name,slug,type,parent_id,is_default,spending_nature,translations)
  VALUES(p_owner,'Uncategorized',v_slug,p_type,v_parent,true,'none','{"en":"Uncategorized","es":"Sin categoría","pt":"Sem categoria"}')
  ON CONFLICT(slug,user_id) DO UPDATE SET parent_id=excluded.parent_id,is_active=true,deleted_at=null
  RETURNING id INTO v_category;
 RETURN v_category;
END $$;
REVOKE ALL ON FUNCTION public.ensure_uncategorized_category(uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.default_transaction_category() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_old_default boolean:=false;
BEGIN
 IF TG_OP='UPDATE' AND NEW.type IS DISTINCT FROM OLD.type AND OLD.category_id=NEW.category_id THEN
  SELECT slug IN ('uncategorized','uncategorized-income') INTO v_old_default FROM public.categories WHERE id=OLD.category_id AND user_id=OLD.user_id;
  IF v_old_default THEN NEW.category_id:=NULL; END IF;
 END IF;
 IF NEW.category_id IS NULL AND NEW.deleted_at IS NULL AND NEW.type IN ('expense','income') THEN
  NEW.category_id:=public.ensure_uncategorized_category(NEW.user_id,NEW.type);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER transactions_default_category BEFORE INSERT OR UPDATE OF category_id,type ON public.transactions
 FOR EACH ROW EXECUTE FUNCTION public.default_transaction_category();

DO $$ DECLARE item record; v_category uuid;
BEGIN
 FOR item IN SELECT DISTINCT user_id,type FROM public.transactions WHERE category_id IS NULL AND deleted_at IS NULL AND type IN ('expense','income') LOOP
  v_category:=public.ensure_uncategorized_category(item.user_id,item.type);
  UPDATE public.transactions SET category_id=v_category WHERE user_id=item.user_id AND type=item.type AND category_id IS NULL AND deleted_at IS NULL;
 END LOOP;
END $$;
