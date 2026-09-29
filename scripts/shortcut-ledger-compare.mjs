/** Read-only, aggregate comparison of private Shortcut exports with one count-confirmed ledger. */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackfillBatches, legacyMessagesToItems } from './shortcut-backfill.mjs';
import { classifyNotice } from './shortcut-notice-audit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = (text) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function compareNoticesToLedger(notices, ledger) {
  const identical = new Map();
  const normalized = new Map();
  for (const row of ledger) {
    if (typeof row.raw_text !== 'string' || !row.raw_text.trim()) continue;
    for (const [index, key] of [
      [identical, row.raw_text],
      [normalized, normalize(row.raw_text)]
    ]) {
      const matches = index.get(key) ?? [];
      matches.push(row);
      index.set(key, matches);
    }
  }
  const result = {
    notices: notices.length,
    identical_raw_match: 0,
    normalized_only_match: 0,
    no_raw_match: 0,
    multiple_identical_raw_matches: 0,
    matched_sources: {},
    by_kind: {}
  };
  for (const item of notices) {
    const exactRows = identical.get(item.raw_text) ?? [];
    const looseRows = exactRows.length ? [] : (normalized.get(normalize(item.raw_text)) ?? []);
    const match = exactRows.length ? 'identical' : looseRows.length ? 'normalized_only' : 'no_raw';
    if (match === 'identical') {
      result.identical_raw_match++;
      if (exactRows.length > 1) result.multiple_identical_raw_matches++;
    } else if (match === 'normalized_only') result.normalized_only_match++;
    else result.no_raw_match++;
    const kind = classifyNotice(item.raw_text);
    result.by_kind[kind] ??= { identical: 0, normalized_only: 0, no_raw: 0 };
    result.by_kind[kind][match]++;
    for (const source of new Set([...exactRows, ...looseRows].map((row) => row.source))) {
      result.matched_sources[source] = (result.matched_sources[source] ?? 0) + 1;
    }
  }
  return result;
}

export function selectNoticesWithoutRawMatch(notices, ledger) {
  const identical = new Set();
  const normalized = new Set();
  for (const row of ledger) {
    if (typeof row.raw_text !== 'string' || !row.raw_text.trim()) continue;
    identical.add(row.raw_text);
    normalized.add(normalize(row.raw_text));
  }
  return notices.filter(
    (item) => !identical.has(item.raw_text) && !normalized.has(normalize(item.raw_text))
  );
}

export async function writePrivateReviewFile(path, payload) {
  if (!isAbsolute(path)) throw new Error('Private review path must be absolute');
  const destination = resolve(path);
  const insideRepo = relative(root, destination);
  if (!insideRepo.startsWith('..') && insideRepo !== '..')
    throw new Error('Private review path must be outside the repository');
  const parent = await stat(dirname(destination));
  if ((parent.mode & 0o077) !== 0) throw new Error('Private review directory must be owner-only');
  try {
    await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Private review file already exists');
    throw error;
  }
}

function env(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/u)
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
      .map((line) => {
        const split = line.indexOf('=');
        return [
          line.slice(0, split).trim(),
          line
            .slice(split + 1)
            .trim()
            .replace(/^['"]|['"]$/gu, '')
        ];
      })
  );
}

async function getRows(url, key, query) {
  const output = [];
  for (let offset = 0; ; offset += 500) {
    const response = await fetch(
      `${url}/rest/v1/transactions?${query}&limit=500&offset=${offset}`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
      }
    );
    if (!response.ok) throw new Error(`Read-only transaction query failed (${response.status})`);
    const page = await response.json();
    output.push(...page);
    if (page.length < 500) return output;
  }
}

async function readJson(path) {
  const bytes = await readFile(path);
  const content =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString('utf16le')
      : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('Invalid JSON input');
  }
}

async function main() {
  const paths = process.argv.filter((arg) => arg.startsWith('--input=')).map((arg) => arg.slice(8));
  const expected = Number(
    process.argv.find((arg) => arg.startsWith('--expected-count='))?.slice(17)
  );
  const outPrivate = process.argv.find((arg) => arg.startsWith('--out-private='))?.slice(14);
  if (!paths.length || !Number.isInteger(expected) || expected <= 0)
    throw new Error(
      'Usage: node scripts/shortcut-ledger-compare.mjs --input=messages.json [--input=another.json] --expected-count=1516'
    );
  const documents = await Promise.all(paths.map(readJson));
  const source = documents[0]?.source;
  const inputs = [];
  for (const document of documents) {
    if (document?.source !== source) throw new Error('Input sources differ');
    inputs.push(...legacyMessagesToItems(document?.items ?? document?.messages));
  }
  const prepared = buildBackfillBatches(inputs, source);
  const notices = prepared.batches.flatMap((batch) => batch.items);
  const [secret, publicEnv] = await Promise.all([
    readFile(resolve(root, '.env.local'), 'utf8').then(env),
    readFile(resolve(root, '../spends-assistant-web/.env.local'), 'utf8').then(env)
  ]);
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = secret.SUPABASE_SERVICE_ROLE;
  if (!/^https:\/\/[^/]+\.supabase\.co$/u.test(url ?? '') || !key)
    throw new Error('Supabase configuration unavailable');
  const identities = await getRows(url, key, 'select=user_id&deleted_at=is.null&order=id.asc');
  const counts = new Map();
  for (const row of identities) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const matches = [...counts].filter(([, count]) => count === expected);
  if (matches.length !== 1) throw new Error('Confirmed count does not identify one profile');
  const ledger = await getRows(
    url,
    key,
    `select=raw_text,source&user_id=eq.${encodeURIComponent(matches[0][0])}&deleted_at=is.null&order=id.asc`
  );
  if (ledger.length !== expected) throw new Error('Active ledger count changed during comparison');
  const comparison = compareNoticesToLedger(notices, ledger);
  if (outPrivate) {
    const unmatched = selectNoticesWithoutRawMatch(notices, ledger);
    if (unmatched.length !== comparison.no_raw_match)
      throw new Error('Raw-text partition differs from aggregate comparison');
    await writePrivateReviewFile(outPrivate, {
      version: 1,
      source,
      expected_ledger_count: expected,
      items: unmatched
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        input: prepared.counts,
        ledger_rows: ledger.length,
        comparison
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Comparison failed'}\n`);
    process.exitCode = 1;
  });
}
