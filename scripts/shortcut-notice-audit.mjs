/** Aggregate private Shortcut notices without sending or printing message bodies. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function classifyNotice(message) {
  const text = message.normalize('NFKC').toLocaleLowerCase('es');
  if (/no te alcanz[oó] para pagar|rechazad[ao]|declinad[ao]|no fue posible|no se pudo realizar/u.test(text))
    return 'failed_payment';
  if (/\b(?:\d{4,8} es el c[oó]digo|tu c[oó]digo|c[oó]digo (?:de verificaci[oó]n|para activar)|clave|token|contrase[nñ]a)\b/u.test(text))
    return 'security';
  if (/aprovecha|promoci[oó]n|oferta|descuento|compra tus paquetes|te invitamos|beneficio|campa[nñ]a|no olvides/u.test(text))
    return 'marketing';
  if (/recibiste|te consignaron|te transfirieron|recibido|consignaci[oó]n|te abonamos/u.test(text))
    return 'incoming';
  if (/transferiste|enviaste|env[ií]as|mandaste|transferencia enviada/u.test(text))
    return 'outgoing_transfer';
  if (/compraste|pagaste|compra realizada|pago exitoso/u.test(text))
    return 'purchase_or_payment';
  return 'unknown';
}

export function auditNotices(messages) {
  if (!Array.isArray(messages)) throw new Error('Input must contain a messages array');
  const bodies = messages.map((message) => {
    const body = typeof message === 'string' ? message : message?.raw_text;
    if (typeof body !== 'string' || !body.trim())
      throw new Error('Input contains an invalid message');
    return body;
  });
  const by_kind = {};
  for (const body of bodies) {
    const kind = classifyNotice(body);
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
  }
  const distinct_bodies = new Set(bodies).size;
  return {
    total: bodies.length,
    distinct_bodies,
    repeated_bodies: bodies.length - distinct_bodies,
    by_kind,
  };
}

async function main() {
  const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
  if (!input) throw new Error('Usage: node scripts/shortcut-notice-audit.mjs --input=messages.json');
  const bytes = await readFile(input);
  const contents = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le')
    : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  let document;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new Error('Invalid JSON input');
  }
  const messages = Array.isArray(document) ? document : document?.messages ?? document?.items;
  process.stdout.write(`${JSON.stringify(auditNotices(messages), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Audit failed'}\n`);
    process.exitCode = 1;
  });
}
