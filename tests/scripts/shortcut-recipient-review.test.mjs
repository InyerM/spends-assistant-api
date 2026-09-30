import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDestination, reviewRecipients } from '../../scripts/shortcut-recipient-review.mjs';

test('extracts the destination rather than the origin or support number', () => {
  const body = 'Bancolombia: Transferiste $50.000 desde tu cuenta *1234 a la cuenta *5678 el 02/01/2026 a las 12:01. Llamanos al 01800012345.';
  assert.deepEqual(extractDestination(body), {
    kind: 'masked_account',
    value: '5678',
    strong: false
  });
  assert.deepEqual(
    extractDestination('Transferiste $50.000 desde tu cuenta *1234 a la cuenta * 91 el 02/01/2026 a las 12:01.'),
    { kind: 'masked_account', value: '91', strong: false }
  );
  assert.deepEqual(
    extractDestination('Transferiste $50.000 desde tu cuenta *1234 a la cuenta *12345678901 el 02/01/2026 a las 12:01.'),
    { kind: 'masked_account', value: '12345678901', strong: false }
  );
  assert.deepEqual(
    extractDestination('Transferiste $50.000 desde tu cuenta *1234 a la cuenta *3001234567 el 02/01/2026 a las 12:01.'),
    { kind: 'phone', value: '3001234567', strong: true }
  );
});

test('extracts a full Bre-B key without treating a recipient name as an account', () => {
  const body = 'Bancolombia: INYER, transferiste $20.000 a la llave @merchant123 desde tu cuenta *1234 a ALGUIEN el 03/02/2026 a las 18:30.';
  assert.deepEqual(extractDestination(body), {
    kind: 'breb_key',
    value: '@merchant123',
    strong: true
  });
  assert.equal(extractDestination('Nequi: No te alcanzo para pagar $20.000'), null);
});

test('groups distinct event days and uses only unambiguous prior labels for a review suggestion', () => {
  const make = (day, key) => {
    const month = day < 3 ? '01' : '02';
    const localDay = String(day < 3 ? day : day - 2).padStart(2, '0');
    return {
      received_at: `2026-${month}-${localDay}T10:00:00-05:00`,
      raw_text: `Transferiste $10.000 a la llave ${key} desde tu cuenta *1234 el ${localDay}/${month}/2026 a las 10:00.`
    };
  };
  const notices = [make(1, '@alice'), make(2, '@alice'), make(3, '@alice')];
  const ledger = notices.map((notice, i) => ({
    id: `tx-${i}`,
    raw_text: notice.raw_text,
    category_id: 'food',
    type: 'expense'
  }));
  const result = reviewRecipients(notices, ledger, [{ id: 'food', name: 'Food' }]);
  assert.equal(result.summary.transfer_notices, 3);
  assert.equal(result.groups[0].distinct_event_days, 3);
  assert.equal(result.groups[0].observed_category?.name, 'Food');
  assert.equal(result.groups[0].review_suggestion?.category_id, 'food');
  assert.equal(result.groups[0].review_suggestion?.create_rule, false);
});

test('masked suffix and conflicting labels never produce a category rule suggestion', () => {
  const raw = 'Transferiste $10.000 desde tu cuenta *1234 a la cuenta *5678 el 02/01/2026 a las 12:01.';
  const result = reviewRecipients(
    [{ received_at: '2026-01-02T12:01:00-05:00', raw_text: raw }],
    [{ id: 'one', raw_text: raw, category_id: 'food', type: 'expense' }],
    [{ id: 'food', name: 'Food' }]
  );
  assert.equal(result.groups[0].review_suggestion, null);
  assert.equal(result.groups[0].identity_strength, 'weak');
});
