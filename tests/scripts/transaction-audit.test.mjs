import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { auditTransactions } from '../../scripts/transaction-audit.mjs';

const accounts = [{ id: 'a', type: 'checking', balance: 100, is_active: true }];
const categories = [{ id: 'c', type: 'expense', slug: 'groceries', is_active: true }];
const base = {
  id: '1',
  date: '2026-01-01',
  time: '12:00',
  amount: 100,
  description: 'Purchase',
  account_id: 'a',
  type: 'expense',
  source: 'manual',
  category_id: 'c',
  confidence: 90
};

test('same date, account and amount alone is only a possible duplicate', () => {
  const result = auditTransactions(
    [{ ...base }, { ...base, id: '2', description: 'Different merchant', time: '18:00' }],
    accounts,
    categories
  );
  assert.equal(result.duplicateSignals.possiblePairs, 1);
  assert.equal(result.duplicateSignals.strongPairs, 0);
});

test('matching raw text plus amount and account is a stronger duplicate signal', () => {
  const result = auditTransactions(
    [
      { ...base, raw_text: 'synthetic message' },
      { ...base, id: '2', raw_text: 'synthetic message' }
    ],
    accounts,
    categories
  );
  assert.equal(result.duplicateSignals.strongPairs, 1);
});

test('category type mismatch and inactive references are counted separately', () => {
  const result = auditTransactions([{ ...base, type: 'income' }], accounts, categories);
  assert.equal(result.categoryQuality.typeMismatch, 1);
  assert.equal(result.categoryQuality.inactive, 0);
});

test('transfer hints are review signals and not automatic reclassification', () => {
  const result = auditTransactions(
    [{ ...base, description: 'Transfer to Nequi' }],
    accounts,
    categories
  );
  assert.equal(result.reviewSignals.transferLikeExpense, 1);
  assert.equal(result.byType.expense, 1);
});

test('balances with no opening value are reported as an unverified net movement', () => {
  const result = auditTransactions([{ ...base }], accounts, categories);
  assert.equal(result.accountQuality.netMovementWithoutOpeningBalance.length, 1);
  assert.equal(result.accountQuality.netMovementWithoutOpeningBalance[0].movement, -100);
  assert.equal(result.accountQuality.netMovementWithoutOpeningBalance[0].reconciled, false);
});

test('unexpected source labels are redacted from aggregate output', () => {
  const result = auditTransactions(
    [{ ...base, source: 'private custom label' }],
    accounts,
    categories
  );
  assert.equal(result.bySource.other, 1);
  assert.equal(JSON.stringify(result).includes('private custom label'), false);
});
