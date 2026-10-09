import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('owner balance target RPC', () => {
  const path = 'supabase/migrations/20261008000031_account_balance_target.sql';
  it('locks the owned account and derives the delta from its authoritative balance', () => {
    const sql = readFileSync(path, 'utf8');
    expect(sql).toMatch(/user_id = v_user[\s\S]*FOR UPDATE/);
    expect(sql).toContain('v_delta := p_target - coalesce(v_account.balance, 0)');
    expect(sql).toContain('public.confirm_manual_transaction(');
    expect(sql).toContain("IF p_mode = 'transaction' AND v_delta <> 0");
  });
  it('audits and replays requests behind auth, terms and owner checks', () => {
    const sql = readFileSync(path, 'utf8');
    expect(sql).toContain('public.has_accepted_required_terms()');
    expect(sql).toContain('PRIMARY KEY (user_id, request_id)');
    expect(sql).toContain('request_id already belongs to a different payload');
    expect(sql).toContain('REVOKE ALL ON public.account_balance_adjustments');
    expect(sql).toContain('TO authenticated');
  });
});
