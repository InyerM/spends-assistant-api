/** Read-only, deterministic proposals for one count-confirmed Supabase profile. Node 20+. */
import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dayMs = 86_400_000;
const genericDescription =
  /^(compra|pago|transferencia|transaccion|movimiento|gasto|ingreso|retiro|consignacion|nequi|sin descripcion|payment|purchase)( de| a| por| en)?\s*$/;

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const isSpecific = (value) => {
  const text = normalize(value);
  return text.length >= 6 && !genericDescription.test(text);
};
const cents = (value) => {
  const amount = Number(value);
  const result = Math.round(amount * 100);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(result) ? result : null;
};
const dateStamp = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value
    ? stamp
    : null;
};

function validCategory(category, type) {
  return (
    category &&
    category.type === type &&
    category.is_active !== false &&
    !category.deleted_at &&
    !['missing', 'uncategorized'].includes(category.slug)
  );
}

function categoryProposals(rows, categories) {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const peersByKey = new Map();
  const keyFor = (row) => JSON.stringify([row.account_id, row.type, normalize(row.description)]);
  for (const row of rows) {
    const category = categoryMap.get(row.category_id);
    if (
      !isSpecific(row.description) ||
      !validCategory(category, row.type) ||
      dateStamp(row.date) === null
    )
      continue;
    const key = keyFor(row);
    const peers = peersByKey.get(key) ?? [];
    peers.push(row);
    peersByKey.set(key, peers);
  }
  const proposals = [];
  for (const target of rows) {
    const existing = categoryMap.get(target.category_id);
    const isUncategorized =
      !target.category_id || (existing && ['missing', 'uncategorized'].includes(existing.slug));
    if (!isUncategorized || !isSpecific(target.description) || dateStamp(target.date) === null)
      continue;
    const peers = (peersByKey.get(keyFor(target)) ?? [])
      .filter((peer) => peer.id !== target.id && peer.date < target.date)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (peers.length < 3 || new Set(peers.map((peer) => peer.date)).size < 3) continue;
    const categoryIds = new Set(peers.map((peer) => peer.category_id));
    if (categoryIds.size !== 1) continue;
    proposals.push({
      transaction_id: target.id,
      kind: 'category_suggestion',
      before: { category_id: target.category_id },
      after: { category_id: peers[0].category_id },
      reason: 'unanimous_historical_precedents',
      confidence: 'high',
      evidence: {
        peer_transaction_ids: peers.map((peer) => peer.id),
        peer_dates: [...new Set(peers.map((peer) => peer.date))].sort(),
        same_account: true,
        same_type: true,
        exact_normalized_description: true
      }
    });
  }
  return proposals;
}

function descriptionProposals(rows) {
  return rows.flatMap((row) => {
    const description = normalize(row.description);
    const reason = !description
      ? 'empty_description'
      : genericDescription.test(description)
        ? 'generic_description'
        : null;
    if (!reason) return [];
    return [
      {
        transaction_id: row.id,
        kind: 'description_review',
        before: { description: row.description },
        after: null,
        reason,
        confidence: 'manual_review',
        evidence: { requires_user_authored_description: true }
      }
    ];
  });
}

function recurrenceProposals(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (!isSpecific(row.description) || dateStamp(row.date) === null || cents(row.amount) === null)
      continue;
    const context = normalize([row.description, row.notes, row.raw_text, row.source].join(' '));
    if (!/\bnequi\b/.test(context)) continue;
    const key = JSON.stringify([
      row.account_id,
      row.type,
      normalize(row.description),
      cents(row.amount)
    ]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  const proposals = [];
  let recurringGroups = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 3 || new Set(bucket.map((row) => row.date)).size !== bucket.length)
      continue;
    bucket.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const flush = (run) => {
      if (run.length < 3) return;
      recurringGroups++;
      const dates = run.map((row) => row.date);
      const intervals = dates
        .slice(1)
        .map((date, index) => (dateStamp(date) - dateStamp(dates[index])) / dayMs);
      const ids = run.map((row) => row.id);
      for (const row of run)
        proposals.push({
          transaction_id: row.id,
          kind: 'recurrence_review',
          before: {
            date: row.date,
            amount: row.amount,
            description: row.description,
            category_id: row.category_id
          },
          after: null,
          reason: 'recurring_nequi_pattern',
          confidence: 'moderate',
          evidence: {
            dates,
            interval_days: intervals,
            group_transaction_ids: ids,
            same_account: true,
            same_type: true,
            same_amount: true,
            exact_normalized_description: true
          }
        });
    };
    let run = [bucket[0]];
    for (const current of bucket.slice(1)) {
      const days = (dateStamp(current.date) - dateStamp(run.at(-1).date)) / dayMs;
      if (days >= 25 && days <= 35) run.push(current);
      else {
        flush(run);
        run = [current];
      }
    }
    flush(run);
  }
  return { proposals, recurringGroups };
}

export function buildReviewProposals(inputRows, categories) {
  const rows = inputRows.filter((row) => !row.deleted_at).sort((a, b) => a.id.localeCompare(b.id));
  const owners = new Set(rows.map((row) => row.user_id));
  if (
    owners.size > 1 ||
    categories.some(
      (category) => category.user_id && owners.size === 1 && category.user_id !== rows[0].user_id
    )
  )
    throw new Error('Mixed-owner input');
  const categoryItems = categoryProposals(rows, categories);
  const descriptionItems = descriptionProposals(rows);
  const recurrence = recurrenceProposals(rows);
  const proposals = [...categoryItems, ...descriptionItems, ...recurrence.proposals].sort(
    (a, b) => a.transaction_id.localeCompare(b.transaction_id) || a.kind.localeCompare(b.kind)
  );
  return {
    schema_version: 1,
    owner_id: rows[0]?.user_id ?? null,
    examined: rows.length,
    counts: {
      total: proposals.length,
      category_suggestions: categoryItems.length,
      description_reviews: descriptionItems.length,
      recurrence_reviews: recurrence.proposals.length,
      recurring_groups: recurrence.recurringGroups
    },
    proposals
  };
}

async function pagedRows({ url, key, table, select, filters = {}, pageSize, fetchImpl }) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const endpoint = new URL(`/rest/v1/${table}`, url);
    endpoint.searchParams.set('select', select);
    for (const [field, value] of Object.entries(filters)) endpoint.searchParams.set(field, value);
    endpoint.searchParams.set('order', 'id.asc');
    endpoint.searchParams.set('limit', String(pageSize));
    endpoint.searchParams.set('offset', String(offset));
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Read-only profile query failed');
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Invalid profile query response');
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

export async function loadConfirmedProfile({
  url,
  key,
  expectedCount,
  pageSize = 500,
  fetchImpl = fetch
}) {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0
  )
    throw new Error('Invalid expected count or page size');
  const identities = await pagedRows({
    url,
    key,
    table: 'transactions',
    select: 'user_id',
    filters: { deleted_at: 'is.null' },
    pageSize,
    fetchImpl
  });
  const counts = new Map();
  for (const row of identities)
    if (row.user_id) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const matches = [...counts].filter(([, count]) => count === expectedCount);
  if (matches.length !== 1) throw new Error('Confirmed count does not identify one profile');
  const ownerId = matches[0][0];
  const scope = { user_id: `eq.${ownerId}` };
  const rows = await pagedRows({
    url,
    key,
    table: 'transactions',
    select: 'id,user_id,date,amount,type,account_id,category_id,description,notes,raw_text,source',
    filters: { ...scope, deleted_at: 'is.null' },
    pageSize,
    fetchImpl
  });
  if (rows.length !== expectedCount || rows.some((row) => row.user_id !== ownerId))
    throw new Error('Active-row count or owner changed during export');
  const categories = await pagedRows({
    url,
    key,
    table: 'categories',
    select: 'id,user_id,slug,type,is_active,deleted_at',
    filters: scope,
    pageSize,
    fetchImpl
  });
  if (categories.some((category) => category.user_id !== ownerId))
    throw new Error('Category owner changed during export');
  return { ownerId, rows, categories };
}

export async function writePrivateReport(
  report,
  { outputRoot = tmpdir(), repoRoot: projectRoot = repoRoot } = {}
) {
  const realOutput = await realpath(outputRoot);
  const realRepo = await realpath(projectRoot);
  const insideRepo = relative(realRepo, realOutput);
  if (!insideRepo.startsWith('..') && !isAbsolute(insideRepo))
    throw new Error('Output root must be outside the repository');
  const folder = await mkdtemp(join(realOutput, 'spends-review-proposals-'));
  await chmod(folder, 0o700);
  const path = join(folder, 'proposals.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export function summaryLine(report, path) {
  return JSON.stringify({ examined: report.examined, counts: report.counts, path });
}

function readEnv(content) {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const split = line.indexOf('=');
        return [
          line.slice(0, split),
          line
            .slice(split + 1)
            .trim()
            .replace(/^['"]|['"]$/g, '')
        ];
      })
  );
}

function option(name) {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const expectedCount = Number(option('expected-count'));
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0)
    throw new Error('Supply a positive --expected-count');
  const backend = option('backend-env')
    ? readEnv(await readFile(option('backend-env'), 'utf8'))
    : {};
  const web = option('web-env') ? readEnv(await readFile(option('web-env'), 'utf8')) : {};
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    web.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    backend.SUPABASE_SERVICE_ROLE;
  if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url ?? '') || !key)
    throw new Error('Supabase configuration unavailable');
  const { rows, categories } = await loadConfirmedProfile({ url, key, expectedCount });
  const report = buildReviewProposals(rows, categories);
  const path = await writePrivateReport(report, { outputRoot: option('out-dir') ?? tmpdir() });
  process.stdout.write(`${summaryLine(report, path)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('Private review proposal export failed\n');
    process.exitCode = 1;
  });
}
