import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildBackfillBatches,
  emailMessagesToItems,
  legacyMessagesToItems
} from '../../scripts/shortcut-backfill.mjs';

const item = (received_at, raw_text, external_id = null) => ({
  received_at,
  raw_text,
  external_id
});

test('keeps only 2026 messages that are absent from the inbox export', () => {
  const first = item('2026-01-02T12:00:00-05:00', 'Payment A');
  const second = item('2026-01-02T13:00:00-05:00', 'Payment B', 'stable-2');
  const result = buildBackfillBatches(
    [first, second, item('2025-12-31T12:00:00-05:00', 'Earlier')],
    'sms-manual-backfill',
    { version: 1, items: [{ ...first, source: 'sms-manual-backfill' }] }
  );
  assert.deepEqual(result.batches, [{ source: 'sms-manual-backfill', items: [second] }]);
  assert.deepEqual(result.counts, {
    input: 3,
    outside_year: 1,
    already_in_export: 1,
    repeated_in_input: 0,
    ready_for_review: 1
  });
});

test('same text at a different receipt instant remains a distinct message', () => {
  const result = buildBackfillBatches(
    [
      item('2026-05-01T12:00:00-05:00', 'Payment A'),
      item('2026-05-01T13:00:00-05:00', 'Payment A')
    ],
    'sms-manual-backfill'
  );
  assert.equal(result.counts.ready_for_review, 2);
});

test('repeated external ID with conflicting content is rejected', () => {
  assert.throws(
    () =>
      buildBackfillBatches(
        [
          item('2026-05-01T12:00:00-05:00', 'Payment A', 'stable'),
          item('2026-05-01T12:00:00-05:00', 'Payment B', 'stable')
        ],
        'sms-manual-backfill'
      ),
    /Conflicting message identity/
  );
});

test('missing original timestamp and invalid calendar dates are rejected', () => {
  assert.throws(
    () => buildBackfillBatches([item('2026-05-01', 'Payment A')], 'sms-manual-backfill'),
    /Invalid input item/
  );
  assert.throws(
    () =>
      buildBackfillBatches([item('2026-02-30T12:00:00-05:00', 'Payment A')], 'sms-manual-backfill'),
    /Invalid input item/
  );
});

test('splits bounded batches and leaves transaction creation to web review', () => {
  const messages = Array.from({ length: 26 }, (_, index) =>
    item(`2026-06-01T12:00:${String(index).padStart(2, '0')}-05:00`, `Payment ${index}`)
  );
  const result = buildBackfillBatches(messages, 'sms-manual-backfill');
  assert.deepEqual(
    result.batches.map((batch) => batch.items.length),
    [25, 1]
  );
  assert.equal(result.batches[0].items[0].raw_text, 'Payment 0');
  assert.equal(result.batches[0].items[0].amount, undefined);
});

test('CLI writes private JSON and refuses to reuse an output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'spends-backfill-test-'));
  try {
    const inputPath = join(root, 'input.json');
    const outputPath = join(root, 'prepared');
    writeFileSync(
      inputPath,
      JSON.stringify({
        source: 'sms-manual-backfill',
        items: [item('2026-09-01T12:00:00-05:00', 'Synthetic private message')]
      })
    );
    const args = [
      'scripts/shortcut-backfill.mjs',
      `--input=${inputPath}`,
      `--out-dir=${outputPath}`
    ];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.includes('Synthetic private message'), false);
    assert.equal(statSync(outputPath).mode & 0o777, 0o700);
    assert.equal(statSync(join(outputPath, 'batch-001.json')).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(join(outputPath, 'batch-001.json'), 'utf8')).items[0].raw_text,
      'Synthetic private message'
    );
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(second.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI reads a UTF-16LE Shortcut export without changing message content', () => {
  const root = mkdtempSync(join(tmpdir(), 'spends-utf16-test-'));
  try {
    const inputPath = join(root, 'messages.txt');
    const outputPath = join(root, 'prepared');
    const payload = JSON.stringify({
      source: 'sms-manual-backfill',
      items: [item('2026-09-01T12:00:00-05:00', 'Synthetic Bancolombia purchase')]
    });
    writeFileSync(
      inputPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, 'utf16le')])
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/shortcut-backfill.mjs', `--input=${inputPath}`, `--out-dir=${outputPath}`],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const batch = JSON.parse(readFileSync(join(outputPath, 'batch-001.json'), 'utf8'));
    assert.equal(batch.items[0].raw_text, 'Synthetic Bancolombia purchase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI does not print private input when JSON is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'spends-invalid-json-test-'));
  try {
    const inputPath = join(root, 'messages.txt');
    writeFileSync(inputPath, 'private-sensitive-input');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/shortcut-backfill.mjs',
        `--input=${inputPath}`,
        `--out-dir=${join(root, 'prepared')}`
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid JSON input/);
    assert.equal(result.stderr.includes('private-sensitive-input'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy Nequi receipt prefix becomes a timestamp without changing raw text', () => {
  const raw = '[Recibido: 15/09/2026 14:30] Nequi: Pagaste synthetic amount';
  assert.deepEqual(legacyMessagesToItems([raw]), [item('2026-09-15T14:30:00-05:00', raw)]);
});

test('legacy messages without an original receipt prefix require metadata', () => {
  assert.throws(
    () => legacyMessagesToItems(['Bancolombia: Compraste el 15/09/2026']),
    /Original receipt timestamp required/
  );
});

test('legacy adapter rejects impossible receipt dates', () => {
  assert.throws(
    () => legacyMessagesToItems(['[Recibido: 31/02/2026 14:30] Nequi: Pagaste']),
    /Original receipt timestamp required/
  );
});

test('Lulo email export preserves channel evidence in a reviewed inbox item', () => {
  const messages = emailMessagesToItems([
    {
      message_id: 'mail-001',
      received_at: '2026-09-26T12:00:00-05:00',
      from: 'Lulo Bank <notifications@example.invalid>',
      subject: 'Card purchase',
      text: 'A synthetic card purchase was made.'
    }
  ]);
  assert.deepEqual(messages, [
    item(
      '2026-09-26T12:00:00-05:00',
      'From: Lulo Bank <notifications@example.invalid>\nSubject: Card purchase\n\nA synthetic card purchase was made.',
      'mail-001'
    )
  ]);
  const result = buildBackfillBatches(messages, 'lulo-email-backfill');
  assert.equal(result.counts.ready_for_review, 1);
});

test('email adapter rejects missing body, timestamp, and oversized content', () => {
  const base = {
    message_id: 'mail-001',
    received_at: '2026-09-26T12:00:00-05:00',
    from: 'sender@example.invalid',
    subject: 'Synthetic',
    text: 'Purchase'
  };
  assert.throws(() => emailMessagesToItems([{ ...base, text: '' }]), /Invalid email/);
  assert.throws(
    () => emailMessagesToItems([{ ...base, received_at: '2026-09-26' }]),
    /Invalid email/
  );
  assert.throws(() => emailMessagesToItems([{ ...base, text: 'a'.repeat(4097) }]), /Invalid email/);
});

test('CLI prepares a Lulo email as a review-only JSON batch', () => {
  const root = mkdtempSync(join(tmpdir(), 'spends-mail-test-'));
  try {
    const inputPath = join(root, 'mail.json');
    const outputPath = join(root, 'prepared');
    writeFileSync(
      inputPath,
      JSON.stringify({
        source: 'lulo-email-backfill',
        emails: [
          {
            message_id: 'stable-mail-1',
            received_at: '2026-09-26T12:00:00-05:00',
            from: 'Lulo Bank <notifications@example.invalid>',
            subject: 'Synthetic purchase',
            text: 'Synthetic card purchase'
          }
        ]
      })
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/shortcut-backfill.mjs', `--input=${inputPath}`, `--out-dir=${outputPath}`],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const batch = JSON.parse(readFileSync(join(outputPath, 'batch-001.json'), 'utf8'));
    assert.equal(batch.source, 'lulo-email-backfill');
    assert.equal(batch.items[0].external_id, 'stable-mail-1');
    assert.match(batch.items[0].raw_text, /Synthetic purchase/);
    assert.equal(result.stdout.includes('Synthetic card purchase'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
