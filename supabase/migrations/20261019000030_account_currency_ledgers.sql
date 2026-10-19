-- One visible account may own several currency ledgers. Posting still targets one currency.
ALTER TABLE public.accounts ADD COLUMN parent_account_id uuid REFERENCES public.accounts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX account_currency_ledger_unique ON public.accounts(parent_account_id,currency) WHERE parent_account_id IS NOT NULL;
CREATE INDEX account_currency_ledger_parent ON public.accounts(parent_account_id) WHERE parent_account_id IS NOT NULL;

CREATE FUNCTION public.guard_account_currency_group() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent public.accounts;
BEGIN
 IF TG_OP='UPDATE' AND NEW.parent_account_id IS DISTINCT FROM OLD.parent_account_id THEN
  RAISE EXCEPTION 'Account currency group cannot be changed';
 END IF;
 IF NEW.parent_account_id IS NOT NULL THEN
  SELECT * INTO parent FROM public.accounts WHERE id=NEW.parent_account_id;
  IF NOT FOUND OR parent.user_id<>NEW.user_id OR parent.parent_account_id IS NOT NULL
    OR parent.id=NEW.id OR parent.currency=NEW.currency OR parent.type<>NEW.type THEN
    RAISE EXCEPTION 'Invalid account currency group';
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.deleted_at IS NOT NULL OR NOT NEW.is_active) AND EXISTS(
  SELECT 1 FROM public.accounts WHERE parent_account_id=NEW.id AND is_active AND deleted_at IS NULL
 ) THEN RAISE EXCEPTION 'Disable the other account currencies first'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_currency_group_guard BEFORE INSERT OR UPDATE ON public.accounts
 FOR EACH ROW EXECUTE FUNCTION public.guard_account_currency_group();

CREATE FUNCTION public.enable_account_currency(p_account uuid,p_currency text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user uuid:=auth.uid(); source public.accounts; ledger public.accounts;
BEGIN
 IF v_user IS NULL OR NOT public.has_accepted_required_terms() THEN RAISE EXCEPTION 'Authentication required'; END IF;
 IF p_currency IS NULL OR p_currency NOT IN ('COP','USD') THEN RAISE EXCEPTION 'Unsupported currency'; END IF;
 SELECT * INTO source FROM public.accounts WHERE id=p_account AND user_id=v_user AND is_active AND deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 IF source.parent_account_id IS NOT NULL THEN
  SELECT * INTO source FROM public.accounts WHERE id=source.parent_account_id AND user_id=v_user AND is_active AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('account-currency:'||source.id::text,0));
 PERFORM 1 FROM public.accounts WHERE id=source.id AND user_id=v_user AND is_active AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;
 IF source.currency=p_currency THEN RETURN to_jsonb(source); END IF;
 SELECT * INTO ledger FROM public.accounts WHERE parent_account_id=source.id AND currency=p_currency;
 IF FOUND THEN
  IF NOT ledger.is_active OR ledger.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Account currency is disabled'; END IF;
  RETURN to_jsonb(ledger);
 END IF;
 INSERT INTO public.accounts(user_id,name,type,institution,last_four,bank_account_last_four,identifiers,currency,balance,is_default,color,icon,parent_account_id)
 VALUES(v_user,left(source.name,92)||' · '||p_currency,source.type,source.institution,source.last_four,source.bank_account_last_four,source.identifiers,p_currency,0,false,source.color,source.icon,source.id)
 RETURNING * INTO ledger;
 RETURN to_jsonb(ledger);
END $$;
REVOKE ALL ON FUNCTION public.enable_account_currency(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.enable_account_currency(uuid,text) TO authenticated;
