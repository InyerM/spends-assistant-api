-- Manual sender associations are display metadata, not email authentication or posting authority.
CREATE TABLE public.email_sender_confirmations (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_address text NOT NULL CHECK (sender_address = lower(sender_address) AND char_length(sender_address) BETWEEN 3 AND 254),
  bank_name text NOT NULL CHECK (char_length(bank_name) BETWEEN 2 AND 80 AND bank_name !~ '[[:cntrl:]<>]'),
  source_inbox_item_id uuid REFERENCES public.shortcut_inbox_items(id) ON DELETE SET NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender_address)
);
ALTER TABLE public.email_sender_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_sender_confirmations FROM anon, authenticated;
GRANT SELECT ON public.email_sender_confirmations TO authenticated;
GRANT ALL ON public.email_sender_confirmations TO service_role;
CREATE POLICY email_sender_confirmation_owner_read ON public.email_sender_confirmations
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE FUNCTION public.confirm_email_sender(p_inbox_item_id uuid, p_bank_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_owner uuid := auth.uid();
  v_raw text;
  v_sender text;
  v_result public.email_sender_confirmations;
BEGIN
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_bank_name IS NULL OR char_length(btrim(p_bank_name)) NOT BETWEEN 2 AND 80 OR p_bank_name ~ '[[:cntrl:]<>]' THEN
    RAISE EXCEPTION 'Invalid bank name' USING ERRCODE = '22023';
  END IF;
  SELECT raw_text INTO v_raw FROM public.shortcut_inbox_items
    WHERE id = p_inbox_item_id AND user_id = v_owner AND source = 'forwarded_email';
  IF NOT FOUND THEN RAISE EXCEPTION 'Email not found' USING ERRCODE = 'P0002'; END IF;
  v_sender := lower(btrim(substring(v_raw FROM '^From \(unverified\): ([^\r\n]+)')));
  IF v_sender IS NULL OR char_length(v_sender) > 254 OR v_sender !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$' THEN
    RAISE EXCEPTION 'Invalid sender address' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.email_sender_confirmations(user_id, sender_address, bank_name, source_inbox_item_id)
    VALUES (v_owner, v_sender, btrim(p_bank_name), p_inbox_item_id)
    ON CONFLICT (user_id, sender_address) DO UPDATE SET
      bank_name = EXCLUDED.bank_name, source_inbox_item_id = EXCLUDED.source_inbox_item_id, confirmed_at = now()
    RETURNING * INTO v_result;
  RETURN jsonb_build_object('sender_address', v_result.sender_address, 'bank_name', v_result.bank_name, 'confirmed_at', v_result.confirmed_at);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_email_sender(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_email_sender(uuid, text) TO authenticated;
