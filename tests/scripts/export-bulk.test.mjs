import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../../scripts/export-bulk.js', import.meta.url), 'utf8');

function run(input) {
  let output;
  let completed = false;
  vm.runInNewContext(code, {
    args: { shortcutParameter: input },
    Script: {
      setShortcutOutput(value) {
        output = value;
      },
      complete() {
        completed = true;
      }
    }
  });
  assert.equal(completed, true);
  return output;
}

test('exports the old array without posting or changing message text', () => {
  const messages = [
    '[Recibido: 15/09/2026 14:30] Nequi: Pagaste',
    'Bancolombia: Compra\nReferencia 123'
  ];
  assert.deepEqual(JSON.parse(run(messages)), { source: 'sms-manual-backfill', messages });
});

test('exports structured messages with original timestamps', () => {
  const messages = [{ received_at: '2026-09-15T14:30:00-05:00', raw_text: 'Synthetic SMS' }];
  assert.deepEqual(JSON.parse(run({ messages })), { source: 'sms-manual-backfill', messages });
});

test('keeps a single multi-line message intact', () => {
  assert.deepEqual(JSON.parse(run('First line\nSecond line')).messages, [
    'First line\nSecond line'
  ]);
});

test('refuses an empty list without echoing private content', () => {
  assert.match(run([]), /^Error:/);
  assert.equal(run([42]), 'Error: Input must contain nonempty message strings or objects');
});
