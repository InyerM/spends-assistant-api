import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditNotices, classifyNotice } from '../../scripts/shortcut-notice-audit.mjs';

test('failed payments, marketing, and security alerts do not become payment candidates', () => {
  assert.equal(classifyNotice('Nequi: No te alcanzo para pagar 25000 en tienda'), 'failed_payment');
  assert.equal(classifyNotice('Bancolombia: Aprovecha esta oferta y paga menos'), 'marketing');
  assert.equal(classifyNotice('Bancolombia: 123456 es el codigo para activar tu billetera'), 'security');
});

test('incoming and outgoing notices remain distinct review categories', () => {
  assert.equal(classifyNotice('Bancolombia: Recibiste $100.000'), 'incoming');
  assert.equal(classifyNotice('Bancolombia: Transferiste $100.000'), 'outgoing_transfer');
  assert.equal(classifyNotice('Bancolombia: Compraste $100.000'), 'purchase_or_payment');
  assert.equal(classifyNotice('Bancolombia: Pagaste $100.000 por codigo QR'), 'purchase_or_payment');
  assert.equal(classifyNotice('Bancolombia: Estado de tu tarjeta'), 'unknown');
});

test('audit counts exact repeated bodies but preserves every message for later review', () => {
  const report = auditNotices([
    'Nequi: No te alcanzo para pagar 25000 en tienda',
    'Nequi: No te alcanzo para pagar 25000 en tienda',
    'Bancolombia: Recibiste $100.000',
  ]);
  assert.deepEqual(report, {
    total: 3,
    distinct_bodies: 2,
    repeated_bodies: 1,
    by_kind: { failed_payment: 2, incoming: 1 },
  });
});

test('CLI reads UTF-16LE Shortcut JSON without printing private message text', () => {
  const root = mkdtempSync(join(tmpdir(), 'spends-notice-audit-'));
  try {
    const path = join(root, 'messages.txt');
    const message = 'Bancolombia: Compraste $123.456 en PRIVATE-MERCHANT';
    writeFileSync(path, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JSON.stringify({ messages: [message] }), 'utf16le'),
    ]));
    const result = spawnSync(process.execPath, ['scripts/shortcut-notice-audit.mjs', `--input=${path}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('PRIVATE-MERCHANT'), false);
    assert.equal(JSON.parse(result.stdout).by_kind.purchase_or_payment, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
