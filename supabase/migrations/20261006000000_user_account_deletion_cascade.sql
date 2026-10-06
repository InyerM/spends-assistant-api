-- Legacy owner references predate the cascading user-owned tables. Without
-- cascading references, deleting an auth user leaves these records behind and
-- the auth deletion itself fails.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'accounts', 'categories', 'transactions', 'automation_rules',
    'reconciliations', 'imports', 'skipped_messages'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',
      v_table, v_table || '_user_id_fkey');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
      v_table, v_table || '_user_id_fkey');
  END LOOP;
END;
$$;

-- The app checks this marker before removing Storage objects. It prevents a
-- partially applied release from erasing files while auth deletion is blocked
-- by the former non-cascading references.
CREATE FUNCTION public.account_deletion_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.account_deletion_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_ready() TO service_role;
