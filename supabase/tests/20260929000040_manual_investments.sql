-- Run against a local database after migration 20260929000040. Rolls back fixtures.
BEGIN;
INSERT INTO auth.users(id, aud, role, email, encrypted_password)
VALUES
  ('00000000-0000-4000-8000-000000000901', 'authenticated', 'authenticated', 'investment-test-one@example.invalid', ''),
  ('00000000-0000-4000-8000-000000000902', 'authenticated', 'authenticated', 'investment-test-two@example.invalid', '');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000901', true);

DO $$
DECLARE
  v_event jsonb := '{"action":"create_position","provider":"binance","symbol":"BTC","quote_currency":"USDT","quantity_scale":18,"money_scale":6,"evidence":{"kind":"manual_review","reference":"Local fixture","observed_on":"2026-09-28"}}';
  v_result jsonb;
  v_position uuid;
  v_zero_position uuid;
  v_buy jsonb;
  v_opening jsonb;
BEGIN
  v_result := public.confirm_investment_event('00000000-0000-4000-8000-000000000903', true, v_event);
  v_position := (v_result->>'position_id')::uuid;
  IF v_position IS NULL THEN RAISE EXCEPTION 'Position was not created'; END IF;
  IF (public.confirm_investment_event('00000000-0000-4000-8000-000000000903', true, v_event)->>'replayed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Request replay was not durable';
  END IF;
  IF (SELECT count(*) FROM public.investment_positions WHERE id = v_position) <> 1 THEN
    RAISE EXCEPTION 'Replay created another position';
  END IF;
  BEGIN
    PERFORM public.confirm_investment_event('00000000-0000-4000-8000-000000000903', true,
      v_event || '{"symbol":"ETH"}'::jsonb);
    RAISE EXCEPTION 'Changed replay payload was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.investment_positions(user_id, provider, symbol, quote_currency,
      quantity_scale, money_scale, evidence_id)
    VALUES('00000000-0000-4000-8000-000000000901', 'binance', 'ETH', 'USDT', 18, 6,
      '00000000-0000-4000-8000-000000000999');
    RAISE EXCEPTION 'Direct unreviewed insert was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  v_buy := jsonb_build_object('action', 'buy', 'position_id', v_position,
    'occurred_on', '2026-09-28', 'quantity_atoms', '1000000000000000001',
    'gross_minor', '10000', 'fee_minor', '125', 'evidence',
    jsonb_build_object('kind', 'manual_review', 'reference', 'Local fixture', 'observed_on', '2026-09-28'));
  v_result := public.confirm_investment_event('00000000-0000-4000-8000-000000000904', true, v_buy);
  IF v_result->>'quantity_atoms' <> '1000000000000000001' OR v_result->>'cost_basis_minor' <> '10125' THEN
    RAISE EXCEPTION 'Decimal precision or fee basis was lost';
  END IF;
  v_zero_position := (public.confirm_investment_event('00000000-0000-4000-8000-000000000907', true,
    v_event || '{"symbol":"ETH"}'::jsonb)->>'position_id')::uuid;
  v_opening := jsonb_build_object('action', 'opening', 'position_id', v_zero_position,
    'occurred_on', '2026-09-28', 'quantity_atoms', '1', 'cost_basis_minor', '0',
    'evidence', jsonb_build_object('kind', 'manual_review', 'reference', 'Known zero basis',
      'observed_on', '2026-09-28'));
  BEGIN
    PERFORM public.confirm_investment_event('00000000-0000-4000-8000-000000000908', true, v_opening);
    RAISE EXCEPTION 'Unknown basis was silently stored as zero';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (public.confirm_investment_event('00000000-0000-4000-8000-000000000908', true,
      v_opening || '{"known_zero_basis":true}'::jsonb)->>'cost_basis_minor') <> '0' THEN
    RAISE EXCEPTION 'Acknowledged known zero basis was not stored';
  END IF;
  BEGIN
    PERFORM public.confirm_investment_event('00000000-0000-4000-8000-000000000905', false, v_buy);
    RAISE EXCEPTION 'Unreviewed write was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000902', true);
  IF EXISTS (SELECT 1 FROM public.investment_positions WHERE id = v_position) THEN
    RAISE EXCEPTION 'RLS exposed another user position';
  END IF;
  BEGIN
    PERFORM public.confirm_investment_event('00000000-0000-4000-8000-000000000906', true, v_buy);
    RAISE EXCEPTION 'Cross-owner write was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;
ROLLBACK;
