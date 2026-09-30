/** Read-only review of outgoing transfer destinations in dated Shortcut exports. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyMessagesToItems, buildBackfillBatches } from './shortcut-backfill.mjs';
import { extractFinancialEvidence } from './shortcut-candidate-review.mjs';
import { writePrivateReviewFile } from './shortcut-ledger-compare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function extractDestination(rawText) {
  if (!/\btransferiste\b/iu.test(rawText)) return null;
  const key = /\ba la llave\s+([^\s,.;]+)/iu.exec(rawText)?.[1];
  if (key) return { kind: 'breb_key', value: key.toLowerCase(), strong: true };
  const account = /\ba la cuenta\s+(\*?)\s*(\d{1,20})\b/iu.exec(rawText);
  if (account) {
    if (/^3\d{9}$/u.test(account[2]))
      return { kind: 'phone', value: account[2], strong: true };
    return {
      kind: account[1] ? 'masked_account' : 'account',
      value: account[2],
      strong: false
    };
  }
  const button = /\bpor Bot[oó]n Bancolombia a\s+(.+?)\s+desde producto\b/iu.exec(rawText)?.[1];
  if (button) return { kind: 'button_name', value: button.trim().toLowerCase(), strong: false };
  return null;
}

function eventDay(item, evidence) {
  return evidence.date ?? item.received_at?.slice(0, 10) ?? null;
}

function eventHour(item) {
  const explicit = /\ba las\s+(\d{1,2}):(\d{2})\b/iu.exec(item.raw_text);
  if (explicit && Number(explicit[1]) < 24) return Number(explicit[1]);
  const afterDate = /\b\d{2}\/\d{2}\/\d{4}\s+(\d{1,2}):(\d{2})\b/u.exec(item.raw_text);
  if (afterDate && Number(afterDate[1]) < 24) return Number(afterDate[1]);
  const receiptHour = /^\d{4}-\d{2}-\d{2}T(\d{2}):/u.exec(item.received_at ?? '');
  return receiptHour ? Number(receiptHour[1]) : null;
}

/** Group only explicit outgoing destinations; observed labels come from unique exact raw-text matches. */
export function reviewRecipients(notices, ledger, categories) {
  const byRaw = new Map();
  for (const row of ledger) {
    if (!row.raw_text) continue;
    const matches = byRaw.get(row.raw_text) ?? [];
    matches.push(row);
    byRaw.set(row.raw_text, matches);
  }
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const groups = new Map();
  let transferNotices = 0;
  for (const item of notices) {
    if (!/\btransferiste\b/iu.test(item.raw_text)) continue;
    transferNotices++;
    const destination = extractDestination(item.raw_text);
    if (!destination) continue;
    const identity = `${destination.kind}:${destination.value}`;
    if (!groups.has(identity)) groups.set(identity, { destination, items: [] });
    const evidence = extractFinancialEvidence(item.raw_text);
    const matches = byRaw.get(item.raw_text) ?? [];
    groups.get(identity).items.push({
      received_at: item.received_at,
      event_day: eventDay(item, evidence),
      event_hour: eventHour(item),
      amount: evidence.amount,
      ledger_matches: matches.map((row) => row.id),
      category_id: matches.length === 1 && matches[0].type === 'expense'
        ? matches[0].category_id ?? null
        : null
    });
  }
  const ranked = [...groups.values()].map(({ destination, items }) => {
    const days = [...new Set(items.map((item) => item.event_day).filter(Boolean))].sort();
    const months = [...new Set(days.map((day) => day.slice(0, 7)))].sort();
    const categoryCounts = new Map();
    for (const item of items) {
      if (!item.category_id || !categoryById.has(item.category_id)) continue;
      categoryCounts.set(item.category_id, (categoryCounts.get(item.category_id) ?? 0) + 1);
    }
    const labels = [...categoryCounts].sort((a, b) => b[1] - a[1]);
    const top = labels[0];
    const labeledCount = [...categoryCounts.values()].reduce((sum, count) => sum + count, 0);
    const observed = top
      ? { id: top[0], name: categoryById.get(top[0]).name, count: top[1], labeled_count: labeledCount }
      : null;
    const suggestion = destination.strong && days.length >= 3 && months.length >= 2 &&
      labeledCount >= 3 && top[1] / labeledCount >= 0.8
      && !/uncategorized|sin categor[ií]a/iu.test(observed.name)
      ? { category_id: top[0], category_name: observed.name, create_rule: false,
          basis: 'Consistent categories on uniquely matched existing expense rows; owner review required.' }
      : null;
    const hours = Array.from({ length: 24 }, () => 0);
    for (const item of items) if (item.event_hour !== null) hours[item.event_hour]++;
    const amounts = items.filter((item) => item.amount !== null)
      .map((item) => Number(item.amount)).filter(Number.isFinite);
    return {
      destination,
      identity_strength: destination.strong ? 'strong' : 'weak',
      notice_count: items.length,
      distinct_event_days: days.length,
      months,
      first_day: days[0] ?? null,
      last_day: days.at(-1) ?? null,
      hours,
      amount_range_cop: amounts.length ? [Math.min(...amounts), Math.max(...amounts)] : null,
      exact_ledger_match_count: items.filter((item) => item.ledger_matches.length === 1).length,
      ambiguous_ledger_match_count: items.filter((item) => item.ledger_matches.length > 1).length,
      observed_category: observed,
      category_distribution: labels.map(([id, count]) => ({ id, name: categoryById.get(id).name, count })),
      review_suggestion: suggestion,
      items
    };
  }).sort((a, b) => b.notice_count - a.notice_count || a.destination.kind.localeCompare(b.destination.kind));
  const output = ranked.map((group, index) => ({ alias: `R${String(index + 1).padStart(3, '0')}`, ...group }));
  return {
    summary: {
      transfer_notices: transferNotices,
      with_explicit_destination: output.reduce((sum, group) => sum + group.notice_count, 0),
      destination_groups: output.length,
      recurrent_groups: output.filter((group) => group.distinct_event_days >= 3 && group.months.length >= 2).length,
      strong_category_suggestions: output.filter((group) => group.review_suggestion).length,
      rules_created: 0
    },
    groups: output
  };
}

function env(content) {
  return Object.fromEntries(content.split(/\r?\n/u)
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^['"]|['"]$/gu, '')];
    }));
}

async function getRows(url, key, table, query) {
  const output = [];
  for (let offset = 0; ; offset += 500) {
    const response = await fetch(`${url}/rest/v1/${table}?${query}&limit=500&offset=${offset}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Read-only ${table} query failed (${response.status})`);
    const page = await response.json();
    output.push(...page);
    if (page.length < 500) return output;
  }
}

async function readJson(path) {
  const bytes = await readFile(path);
  const content = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/u, '');
  return JSON.parse(content);
}

async function main() {
  const paths = process.argv.filter((arg) => arg.startsWith('--input=')).map((arg) => arg.slice(8));
  const outputPath = process.argv.find((arg) => arg.startsWith('--out-private='))?.slice(14);
  const expected = Number(process.argv.find((arg) => arg.startsWith('--expected-count='))?.slice(17));
  if (!paths.length || !outputPath || !Number.isInteger(expected) || expected <= 0)
    throw new Error('Usage: node scripts/shortcut-recipient-review.mjs --input=messages.json --out-private=/private/report.json --expected-count=1516');
  const documents = await Promise.all(paths.map(readJson));
  const source = documents[0]?.source;
  const inputs = [];
  for (const document of documents) {
    if (!source || document?.source !== source) throw new Error('Input sources differ');
    inputs.push(...legacyMessagesToItems(document.items ?? document.messages));
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
  const identities = await getRows(url, key, 'transactions', 'select=user_id&deleted_at=is.null');
  const counts = new Map();
  for (const row of identities) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const owners = [...counts].filter(([, count]) => count === expected);
  if (owners.length !== 1) throw new Error('Confirmed count does not identify one profile');
  const scope = `user_id=eq.${encodeURIComponent(owners[0][0])}`;
  const [ledger, categories, rules] = await Promise.all([
    getRows(url, key, 'transactions', `select=id,raw_text,category_id,type&${scope}&deleted_at=is.null`),
    getRows(url, key, 'categories', `select=id,name&${scope}&deleted_at=is.null`),
    getRows(url, key, 'automation_rules', `select=id,rule_type,is_active,match_phone&${scope}&deleted_at=is.null`)
  ]);
  if (ledger.length !== expected) throw new Error('Active ledger count changed during review');
  const report = reviewRecipients(notices, ledger, categories);
  await writePrivateReviewFile(outputPath, {
    version: 1,
    source,
    expected_ledger_count: expected,
    existing_active_rules: rules.filter((rule) => rule.is_active).length,
    summary: report.summary,
    groups: report.groups,
    warning: 'Destination type does not establish Nequi or account ownership. Masked suffixes can collide. No rule or transaction was created.'
  });
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Recipient review failed'}\n`);
    process.exitCode = 1;
  });
}
