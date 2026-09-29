import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extractFinancialEvidence,
  matchLedgerCandidates
} from '../../scripts/shortcut-candidate-review.mjs';

test('extracts explicit amounts in both bank number formats without guessing a date', () => {
  assert.deepEqual(
    extractFinancialEvidence(
      'Bancolombia: Transferiste $10,000.00 desde tu cuenta *1234 el 02/08/2026'
    ),
    { amount: '10000.00', date: '2026-08-02', lastFour: '1234' }
  );
  assert.deepEqual(
    extractFinancialEvidence(
      'Bancolombia: Compraste COP 10.000,00 con tu T.Cred *5678 el 03/08/2026'
    ),
    { amount: '10000.00', date: '2026-08-03', lastFour: '5678' }
  );
  assert.deepEqual(
    extractFinancialEvidence('Bancolombia: Pagaste $10,000.00 desde tu cuenta *1234'),
    { amount: '10000.00', date: null, lastFour: '1234' }
  );
});

test('ranks dated same-account matches above amount-only neighbors without confirming either', () => {
  const evidence = { amount: '10000.00', date: '2026-08-02', lastFour: '1234' };
  const ledger = [
    {
      id: 'same',
      date: '2026-08-02',
      amount: 10000,
      account_id: 'a',
      source: 'csv_import',
      type: 'expense',
      description: 'Synthetic'
    },
    {
      id: 'other-account',
      date: '2026-08-02',
      amount: 10000,
      account_id: 'b',
      source: 'csv_import',
      type: 'expense',
      description: 'Synthetic'
    },
    {
      id: 'near',
      date: '2026-08-04',
      amount: 10000,
      account_id: 'a',
      source: 'csv_import',
      type: 'expense',
      description: 'Synthetic'
    },
    {
      id: 'different-amount',
      date: '2026-08-02',
      amount: 10001,
      account_id: 'a',
      source: 'csv_import',
      type: 'expense',
      description: 'Synthetic'
    }
  ];
  const candidates = matchLedgerCandidates(evidence, ledger, [
    { id: 'a', last_four: '1234' },
    { id: 'b', last_four: '9999' }
  ]);
  assert.deepEqual(
    candidates.map(({ id, signal }) => ({ id, signal })),
    [
      { id: 'same', signal: 'same_amount_date_account' },
      { id: 'other-account', signal: 'same_amount_date' },
      { id: 'near', signal: 'same_amount_near_date_account' }
    ]
  );
  assert.deepEqual(matchLedgerCandidates({ ...evidence, date: null }, ledger, []), []);
});
