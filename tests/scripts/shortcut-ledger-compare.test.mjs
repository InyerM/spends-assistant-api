import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compareNoticesToLedger } from '../../scripts/shortcut-ledger-compare.mjs';

test('separates identical and normalized-only raw matches without calling unmatched items missing', () => {
  const notices = [
    { received_at: '2026-01-01T12:00:00-05:00', raw_text: 'Bancolombia: Compraste $100' },
    { received_at: '2026-01-02T12:00:00-05:00', raw_text: 'Bancolombia:   RECIBISTE $200' },
    { received_at: '2026-01-03T12:00:00-05:00', raw_text: 'Nequi: No te alcanzo para pagar $50' },
  ];
  const ledger = [
    { raw_text: 'Bancolombia: Compraste $100', source: 'sms-bulk' },
    { raw_text: 'bancolombia: recibiste $200', source: 'web-ai' },
  ];
  assert.deepEqual(compareNoticesToLedger(notices, ledger), {
    notices: 3,
    identical_raw_match: 1,
    normalized_only_match: 1,
    no_raw_match: 1,
    multiple_identical_raw_matches: 0,
    matched_sources: { 'sms-bulk': 1, 'web-ai': 1 },
    by_kind: {
      purchase_or_payment: { identical: 1, normalized_only: 0, no_raw: 0 },
      incoming: { identical: 0, normalized_only: 1, no_raw: 0 },
      failed_payment: { identical: 0, normalized_only: 0, no_raw: 1 },
    },
  });
});
