import { readFileSync, writeFileSync } from 'node:fs';
const destination = process.argv[2];
if (!destination) throw new Error('Pass a new migration path');
const catalog = JSON.parse(readFileSync('data/default-categories.json', 'utf8')) as unknown;
const sql = `-- Generated from data/default-categories.json. Preserve IDs, custom names and financial assignments.
CREATE FUNCTION public.default_category_catalog() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $catalog$ SELECT '${JSON.stringify(catalog).replaceAll("'", "''")}'::jsonb $catalog$;
CREATE FUNCTION public.seed_default_categories(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; existing public.categories; parent uuid; legacy_parent text;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(public.default_category_catalog()) ORDER BY (value->>'parent_slug') IS NOT NULL,value->>'slug' LOOP
  parent:=NULL;
  IF item->>'parent_slug' IS NOT NULL THEN
   SELECT id INTO parent FROM public.categories WHERE user_id=p_user AND slug=item->>'parent_slug' AND type=item->>'type';
   IF parent IS NULL THEN CONTINUE; END IF;
  END IF;
  SELECT * INTO existing FROM public.categories WHERE user_id=p_user AND slug=item->>'slug';
  IF NOT FOUND THEN
   INSERT INTO public.categories(user_id,name,slug,type,parent_id,icon,color,is_default,spending_nature,translations)
    VALUES(p_user,item->>'name',item->>'slug',item->>'type',parent,item->>'icon',item->>'color',true,(item->>'spending_nature')::public.spending_nature,item->'translations');
  ELSIF existing.is_default AND existing.deleted_at IS NULL AND existing.type=item->>'type' AND
   (existing.name=item->'legacy'->>'name' OR (item->'legacy' IS NULL AND existing.name=item->>'name')) AND
   (existing.translations IS NULL OR existing.translations=item->'legacy'->'translations' OR existing.translations=item->'translations') THEN
   SELECT slug INTO legacy_parent FROM public.categories WHERE id=existing.parent_id AND user_id=p_user;
   UPDATE public.categories SET name=item->>'name',translations=item->'translations',
    parent_id=CASE WHEN legacy_parent IS NOT DISTINCT FROM item->'legacy'->>'parent_slug' THEN parent ELSE existing.parent_id END
   WHERE id=existing.id AND user_id=p_user;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.seed_default_categories(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.handle_new_user_default_categories() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN PERFORM public.seed_default_categories(NEW.id); RETURN NEW; END $$;
DO $$ DECLARE owner uuid; BEGIN FOR owner IN SELECT DISTINCT user_id FROM public.categories WHERE user_id IS NOT NULL LOOP PERFORM public.seed_default_categories(owner); END LOOP; END $$;
`;
writeFileSync(destination, sql);
