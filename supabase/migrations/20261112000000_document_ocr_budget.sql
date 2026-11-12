-- OCR is a separate, explicit disclosure; existing decisions retain their scope/version.
ALTER TABLE public.ai_consent_decisions DROP CONSTRAINT ai_consent_decisions_scope_check;
ALTER TABLE public.ai_consent_decisions ADD CONSTRAINT ai_consent_decisions_scope_check
 CHECK (scope IN ('financial_text','document_images','forwarded_email','document_ocr'));

CREATE TABLE public.document_ocr_budget_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
 claim_token uuid NOT NULL,
 budget_day date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Bogota')::date,
 reserved_micros bigint NOT NULL CHECK (reserved_micros>0),
 charged_micros bigint NOT NULL CHECK (charged_micros>=0),
 settled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,claim_token)
);
ALTER TABLE public.document_ocr_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_ocr_budget_reservations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.document_ocr_budget_reservations TO service_role;
CREATE INDEX document_ocr_budget_owner_day ON public.document_ocr_budget_reservations(user_id,budget_day);

CREATE FUNCTION public.reserve_document_ocr_budget(p_user_id uuid,p_document_id uuid,p_claim_token uuid,p_amount_micros bigint,p_daily_limit_micros bigint)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reservation uuid; spent bigint;
BEGIN
 IF p_user_id IS NULL OR p_document_id IS NULL OR p_claim_token IS NULL OR p_amount_micros IS NULL OR p_amount_micros<=0 OR p_amount_micros>2167635 OR p_daily_limit_micros IS NULL OR p_daily_limit_micros<=0 OR p_daily_limit_micros>100000000 THEN
 RAISE EXCEPTION 'Invalid OCR budget'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,741));
 PERFORM 1 FROM public.documents WHERE id=p_document_id AND user_id=p_user_id AND status='processing' AND processing_token=p_claim_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Document claim unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.ai_consent_decisions WHERE user_id=p_user_id AND scope='document_ocr' AND version='external-ai-v1' AND granted_at IS NOT NULL AND revoked_at IS NULL) THEN RAISE EXCEPTION 'OCR consent required'; END IF;
 SELECT coalesce(sum(charged_micros),0) INTO spent FROM public.document_ocr_budget_reservations WHERE user_id=p_user_id AND budget_day=(now() AT TIME ZONE 'America/Bogota')::date;
 IF spent+p_amount_micros>p_daily_limit_micros THEN RAISE EXCEPTION 'OCR budget exhausted'; END IF;
 INSERT INTO public.document_ocr_budget_reservations(user_id,document_id,claim_token,reserved_micros,charged_micros) VALUES(p_user_id,p_document_id,p_claim_token,p_amount_micros,p_amount_micros) RETURNING id INTO reservation;
 RETURN reservation;
END; $$;
CREATE FUNCTION public.settle_document_ocr_budget(p_reservation_id uuid,p_actual_micros bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_actual_micros IS NOT NULL AND p_actual_micros<0 THEN RAISE EXCEPTION 'Invalid OCR cost'; END IF;
 UPDATE public.document_ocr_budget_reservations SET charged_micros=coalesce(p_actual_micros,reserved_micros),settled_at=now() WHERE id=p_reservation_id AND settled_at IS NULL;
 RETURN FOUND;
END; $$;
REVOKE ALL ON FUNCTION public.reserve_document_ocr_budget(uuid,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_document_ocr_budget(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_document_ocr_budget(uuid,uuid,uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_document_ocr_budget(uuid,bigint) TO service_role;
