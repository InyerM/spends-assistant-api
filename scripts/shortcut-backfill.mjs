/** Prepare private 2026 Shortcut inbox batches without creating financial rows. Node 20+. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ITEMS = 25;
const MAX_BODY_BYTES = 128 * 1024;
const normalizeText = (text) =>
  text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');

export function legacyMessagesToItems(messages) {
  if (!Array.isArray(messages)) throw new Error('Input must be an array of messages');
  return messages.map((message) => {
    if (typeof message !== 'string') return message;
    const match = /^\[Recibido: (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?\]/u.exec(
      message
    );
    if (!match) throw new Error('Original receipt timestamp required for legacy message');
    const [, day, month, year, hour, minute, second = '00'] = match;
    const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}-05:00`;
    if (!validTimestamp(timestamp))
      throw new Error('Original receipt timestamp required for legacy message');
    return { received_at: timestamp, raw_text: message, external_id: null };
  });
}

export function emailMessagesToItems(emails) {
  if (!Array.isArray(emails)) throw new Error('Email input must be an array');
  return emails.map((email) => {
    if (!email || typeof email !== 'object' || Array.isArray(email))
      throw new Error('Invalid email');
    const { message_id = null, received_at, from, subject, text } = email;
    if (
      !validTimestamp(received_at) ||
      typeof from !== 'string' ||
      !from.trim() ||
      typeof subject !== 'string' ||
      typeof text !== 'string' ||
      !text.trim() ||
      (message_id !== null &&
        (typeof message_id !== 'string' || !message_id.trim() || message_id.length > 256))
    )
      throw new Error('Invalid email');
    const raw_text = `From: ${from.replace(/\s+/gu, ' ').trim()}\nSubject: ${subject.replace(/\s+/gu, ' ').trim()}\n\n${text}`;
    if (raw_text.length > 4096) throw new Error('Invalid email');
    return { received_at, raw_text, external_id: message_id };
  });
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(
      value
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (
    Number(year) < 1900 ||
    Number(year) > 2100 ||
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return false;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function canonicalItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid input item');
  const { received_at, raw_text, external_id = null } = value;
  if (
    !validTimestamp(received_at) ||
    typeof raw_text !== 'string' ||
    raw_text.length > 4096 ||
    normalizeText(raw_text).length === 0 ||
    (external_id !== null &&
      (typeof external_id !== 'string' ||
        external_id.length > 256 ||
        external_id.trim().length === 0))
  )
    throw new Error('Invalid input item');
  return { received_at, raw_text, external_id };
}

function identity(source, item) {
  return JSON.stringify(
    item.external_id === null
      ? [source, 'fallback', normalizeText(item.raw_text), new Date(item.received_at).toISOString()]
      : [source, 'external_id', item.external_id]
  );
}

function equivalent(a, b) {
  return (
    a.external_id === b.external_id &&
    new Date(a.received_at).toISOString() === new Date(b.received_at).toISOString() &&
    normalizeText(a.raw_text) === normalizeText(b.raw_text)
  );
}

function bogotaYear(timestamp) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', year: 'numeric' }).format(
      new Date(timestamp)
    )
  );
}

export function buildBackfillBatches(
  input,
  source,
  inboxExport = { version: 1, items: [] },
  year = 2026
) {
  if (!/^[a-z][a-z0-9_-]{1,39}$/u.test(source)) throw new Error('Invalid source');
  if (!Number.isInteger(year) || year < 1900 || year > 2100) throw new Error('Invalid year');
  if (!Array.isArray(input)) throw new Error('Input must be an array of messages');
  if (inboxExport?.version !== 1 || !Array.isArray(inboxExport.items))
    throw new Error('Invalid inbox export');

  const existing = new Map();
  for (const row of inboxExport.items) {
    if (row?.source !== source) continue;
    const item = canonicalItem(row);
    const key = identity(source, item);
    const previous = existing.get(key);
    if (previous && !equivalent(previous, item))
      throw new Error('Conflicting inbox export identity');
    existing.set(key, item);
  }

  const seen = new Map();
  const ready = [];
  const counts = {
    input: input.length,
    outside_year: 0,
    already_in_export: 0,
    repeated_in_input: 0,
    ready_for_review: 0
  };
  for (const raw of input) {
    const item = canonicalItem(raw);
    if (bogotaYear(item.received_at) !== year) {
      counts.outside_year++;
      continue;
    }
    const key = identity(source, item);
    const previous = seen.get(key) ?? existing.get(key);
    if (previous && !equivalent(previous, item)) throw new Error('Conflicting message identity');
    if (seen.has(key)) {
      counts.repeated_in_input++;
      continue;
    }
    seen.set(key, item);
    if (existing.has(key)) {
      counts.already_in_export++;
      continue;
    }
    ready.push(item);
  }
  counts.ready_for_review = ready.length;

  const batches = [];
  let items = [];
  for (const item of ready) {
    const candidate = [...items, item];
    if (
      candidate.length > MAX_ITEMS ||
      Buffer.byteLength(JSON.stringify({ source, items: candidate })) > MAX_BODY_BYTES
    ) {
      if (items.length === 0) throw new Error('Item exceeds inbox request limit');
      batches.push({ source, items });
      items = [item];
    } else items = candidate;
    if (Buffer.byteLength(JSON.stringify({ source, items })) > MAX_BODY_BYTES)
      throw new Error('Item exceeds inbox request limit');
  }
  if (items.length) batches.push({ source, items });
  return { batches, counts };
}

function argument(name) {
  return process.argv.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function argumentsFor(name) {
  return process.argv
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
}

async function readJson(path) {
  const bytes = await readFile(path);
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString('utf16le')
      : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON input');
  }
}

async function main() {
  const inputPaths = argumentsFor('--input');
  const outDir = argument('--out-dir');
  const sourceArg = argument('--source');
  const exportPath = argument('--inbox-export');
  const year = Number(argument('--year') ?? 2026);
  if (!inputPaths.length || !outDir) {
    throw new Error(
      'Usage: node scripts/shortcut-backfill.mjs --input=messages.json [--input=another-month.json] --out-dir=private-dir [--source=sms-manual-backfill] [--inbox-export=shortcut-inbox.json] [--year=2026]'
    );
  }
  const documents = await Promise.all(inputPaths.map(readJson));
  const source = sourceArg ?? documents[0]?.source;
  const input = [];
  for (const parsed of documents) {
    if (parsed?.source && parsed.source !== source)
      throw new Error('Input source differs from --source or another input');
    const rawInput = Array.isArray(parsed) ? parsed : (parsed?.items ?? parsed?.messages);
    input.push(...(Array.isArray(parsed?.emails)
      ? emailMessagesToItems(parsed.emails)
      : legacyMessagesToItems(rawInput)));
  }
  const inboxExport = exportPath ? await readJson(exportPath) : { version: 1, items: [] };
  const { batches, counts } = buildBackfillBatches(input, source, inboxExport, year);
  await mkdir(outDir, { mode: 0o700 });
  for (const [index, batch] of batches.entries()) {
    const path = join(outDir, `batch-${String(index + 1).padStart(3, '0')}.json`);
    await writeFile(path, `${JSON.stringify(batch, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(
    join(outDir, 'manifest.json'),
    `${JSON.stringify({ year, source, compared_inbox_export: Boolean(exportPath), batch_count: batches.length, counts }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  process.stdout.write(
    `${JSON.stringify({ batch_count: batches.length, compared_inbox_export: Boolean(exportPath), counts })}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
