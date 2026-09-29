-- Run after migration 20260929000050 against an isolated local database.
BEGIN;
INSERT INTO auth.users(id, aud, role, email, encrypted_password) VALUES
('00000000-0000-4000-8000-000000000951','authenticated','authenticated','loan-one@example.invalid',''),
('00000000-0000-4000-8000-000000000952','authenticated','authenticated','loan-two@example.invalid','');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000951',true);
DO $$
DECLARE
  v_create jsonb := '{"action":"create_loan","lender":"lulo_bank","label":"Sourced loan","currency":"COP","money_scale":0,"evidence":{"kind":"statement","reference":"Local statement","observed_on":"2026-09-28"}}';
  v_result jsonb;
  v_loan uuid;
  v_payment jsonb;
BEGIN
  v_result := public.confirm_loan_event('00000000-0000-4000-8000-000000000953',true,v_create);
  v_loan := (v_result->>'loan_id')::uuid;
  IF v_loan IS NULL THEN RAISE EXCEPTION 'Loan missing'; END IF;
  IF (SELECT opening_recorded FROM public.manual_loans WHERE id=v_loan) THEN RAISE EXCEPTION 'Opening was invented'; END IF;
  BEGIN
    UPDATE public.manual_loans SET outstanding_minor='42' WHERE id=v_loan;
    RAISE EXCEPTION 'Direct mutation was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  IF (public.confirm_loan_event('00000000-0000-4000-8000-000000000953',true,v_create)->>'replayed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Replay failed'; END IF;
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000953',true,v_create || '{"label":"Changed"}'::jsonb);
    RAISE EXCEPTION 'Changed replay accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  v_payment := jsonb_build_object('action','payment','loan_id',v_loan,'occurred_on','2026-09-28','cash_paid_minor','12345',
    'principal_minor','10000','interest_minor','2000','insurance_minor','300','fee_minor','45','evidence',v_create->'evidence');
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000954',true,v_payment);
    RAISE EXCEPTION 'Payment without opening accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000954',true,
    jsonb_build_object('action','opening','loan_id',v_loan,'occurred_on','2026-09-28','outstanding_minor','100000000000000000001','evidence',v_create->'evidence'));
  v_result := public.confirm_loan_event('00000000-0000-4000-8000-000000000955',true,v_payment);
  IF v_result->>'outstanding_minor' <> '99999999999999990001' THEN RAISE EXCEPTION 'Principal precision lost'; END IF;
  IF (SELECT interest_expense_minor FROM public.manual_loans WHERE id=v_loan) <> '2000' THEN RAISE EXCEPTION 'Interest allocation lost'; END IF;
  IF (public.confirm_loan_event('00000000-0000-4000-8000-000000000955',true,v_payment)->>'replayed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Payment replay failed'; END IF;
  IF (SELECT count(*) FROM public.manual_loan_events WHERE loan_id=v_loan AND kind='payment') <> 1 THEN RAISE EXCEPTION 'Replay duplicated payment'; END IF;
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000958',true,
      v_payment || '{"occurred_on":"2026-09-27"}'::jsonb);
    RAISE EXCEPTION 'Backdated payment accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000956',true,v_payment || '{"cash_paid_minor":"12344"}'::jsonb);
    RAISE EXCEPTION 'Wrong allocation accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000956',false,v_payment);
    RAISE EXCEPTION 'Unreviewed payment accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000952',true);
  IF EXISTS(SELECT 1 FROM public.manual_loans WHERE id=v_loan) THEN RAISE EXCEPTION 'RLS leaked loan'; END IF;
  BEGIN
    PERFORM public.confirm_loan_event('00000000-0000-4000-8000-000000000957',true,v_payment);
    RAISE EXCEPTION 'Cross-owner payment accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;
ROLLBACK;
