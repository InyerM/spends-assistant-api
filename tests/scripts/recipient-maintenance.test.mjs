import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  categoryEditStatus,
  matchesPlannedRule
} from '../../scripts/recipient-maintenance.mjs';

const row = {
  id: 'row-1',
  user_id: 'owner-1',
  type: 'expense',
  amount: 25000,
  category_id: null,
  updated_at: '2026-09-29T10:00:00Z',
  raw_text: 'Transferiste $25.000 a la cuenta *3001234567'
};
const edit = {
  id: 'row-1',
  category_id: 'personal-care',
  expected: {
    category_id: null,
    type: 'expense',
    amount: 25000,
    updated_at: row.updated_at,
    raw_sha256: createHash('sha256').update(row.raw_text).digest('hex')
  }
};

test('category edits require the exact reviewed row and source body', () => {
  assert.equal(categoryEditStatus(row, edit, 'owner-1'), 'pending');
  assert.equal(categoryEditStatus({ ...row, amount: 30000 }, edit, 'owner-1'), 'conflict');
  assert.equal(categoryEditStatus({ ...row, raw_text: 'another message' }, edit, 'owner-1'), 'conflict');
  assert.equal(categoryEditStatus({ ...row, user_id: 'other' }, edit, 'owner-1'), 'conflict');
  assert.equal(categoryEditStatus({ ...row, updated_at: 'later' }, edit, 'owner-1'), 'conflict');
});

test('rerunning a successfully applied category edit is idempotent', () => {
  assert.equal(categoryEditStatus({ ...row, category_id: edit.category_id }, edit, 'owner-1'), 'done');
});

test('a planned rule requires every raw-text term and optional source', () => {
  const rule = {
    condition_logic: 'and',
    conditions: {
      raw_text_contains: ['transferiste', 'a la cuenta', '3001234567'],
      source: ['sms-shortcut']
    }
  };
  assert.equal(matchesPlannedRule(rule, { ...row, source: 'sms-shortcut' }), true);
  assert.equal(matchesPlannedRule(rule, { ...row, source: 'email' }), false);
  assert.equal(matchesPlannedRule(rule, { ...row, raw_text: 'Recibiste desde 3001234567', source: 'sms-shortcut' }), false);
});

test('amount, account, and description restrictions prevent unrelated matches', () => {
  const rule = {
    condition_logic: 'and',
    conditions: {
      raw_text_contains: ['transferiste'],
      amount_between: [20000, 30000],
      from_account: 'bank-1',
      description_regex: '^Haircut'
    }
  };
  const candidate = { ...row, account_id: 'bank-1', description: 'Haircut' };
  assert.equal(matchesPlannedRule(rule, candidate), true);
  assert.equal(matchesPlannedRule(rule, { ...candidate, amount: 35000 }), false);
  assert.equal(matchesPlannedRule(rule, { ...candidate, account_id: 'bank-2' }), false);
  assert.equal(matchesPlannedRule(rule, { ...candidate, description: 'Groceries' }), false);
});

test('paged reads keep every row when unordered pages would overlap', async () => {
  const { getRows } = await import('../../scripts/recipient-maintenance.mjs');
  assert.equal(typeof getRows, 'function');
  const records = Array.from({ length: 601 }, (_, index) => ({
    id: `row-${String(index).padStart(3, '0')}`
  }));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (endpoint) => {
    const url = new URL(endpoint);
    requests.push(url);
    const offset = Number(url.searchParams.get('offset'));
    const page = offset === 500 && url.searchParams.get('order') !== 'id.asc'
      ? records.slice(400, 501)
      : records.slice(offset, offset + 500);
    return { ok: true, json: async () => page };
  };
  try {
    const rows = await getRows('https://example.supabase.co', 'test-key',
      'transactions', 'select=*&user_id=eq.owner');
    assert.equal(rows.length, 601);
    assert.equal(new Set(rows.map((row) => row.id)).size, 601);
    assert.ok(requests.every((request) => request.searchParams.get('order') === 'id.asc'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
