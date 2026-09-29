/** Read-only, private ledger suggestions for AI-triaged Shortcut notices. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivateReviewFile } from './shortcut-ledger-compare.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const financialKinds = new Set([
  'posted_purchase',
  'outgoing_transfer',
  'incoming_transfer',
  'internal_transfer',
  'card_payment',
  'refund',
  'cash_withdrawal'
]);

function parseAmount(raw) {
  const text = raw.replace(/[.,]$/u, '');
  let decimal;
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/u.test(text))
    decimal = text.replaceAll('.', '').replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/u.test(text)) decimal = text.replaceAll(',', '');
  else if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(text)) decimal = text.replaceAll(/[.,]/gu, '');
  else if (/^\d+[.,]\d{1,2}$/u.test(text)) decimal = text.replace(',', '.');
  else if (/^\d+$/u.test(text)) decimal = text;
  else return null;
  const value = Number(decimal);
  return Number.isFinite(value) && value > 0 && value <= 9_999_999_999_999
    ? value.toFixed(2)
    : null;
}

function parseDate(day, month, year) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDay) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Extract only uniquely explicit fields; a receipt instant is never an event date. */
export function extractFinancialEvidence(rawText) {
  const amounts = [
    ...rawText.matchAll(
      /\b(?:compraste|pagaste|transferiste|enviaste|retiraste|recibiste|consignaste|abonaste)\b[^$\n]{0,80}?(?:\$|COP\s*\$?)\s*([0-9][0-9.,]*)/giu
    )
  ];
  const amount = amounts.length === 1 ? parseAmount(amounts[0][1]) : null;
  const dates = [
    ...rawText.matchAll(/\b(?:(\d{2})\/(\d{2})\/(\d{4})|(\d{4})-(\d{2})-(\d{2}))\b/gu)
  ];
  const date =
    dates.length === 1
      ? dates[0][1]
        ? parseDate(Number(dates[0][1]), Number(dates[0][2]), Number(dates[0][3]))
        : parseDate(Number(dates[0][6]), Number(dates[0][5]), Number(dates[0][4]))
      : null;
  const accounts = [
    ...rawText.matchAll(/\b(?:T\.?Deb|T\.?Cred|tarjeta|cuenta)\b[^*\n]{0,50}\*{1,4}(\d{4})\b/giu)
  ];
  return {
    amount,
    date: amount ? date : null,
    lastFour: accounts.length === 1 ? accounts[0][1] : null
  };
}

/** A bounded suggestion list; amount/date/account signals never confirm duplication. */
export function matchLedgerCandidates(evidence, ledger, accounts, limit = 10) {
  if (!evidence.amount || !evidence.date) return [];
  const eventStamp = Date.parse(`${evidence.date}T00:00:00Z`);
  if (!Number.isFinite(eventStamp)) return [];
  const amountCents = Math.round(Number(evidence.amount) * 100);
  const accountMatches = evidence.lastFour
    ? accounts.filter((account) => account.last_four === evidence.lastFour)
    : [];
  const uniqueAccount = accountMatches.length === 1 ? accountMatches[0].id : null;
  const ranked = [];
  for (const row of ledger) {
    if (Math.round(Number(row.amount) * 100) !== amountCents) continue;
    const rowStamp = Date.parse(`${row.date}T00:00:00Z`);
    const days = Math.abs(rowStamp - eventStamp) / 86_400_000;
    if (!Number.isFinite(days) || days > 3) continue;
    const sameDate = days === 0;
    const sameAccount = uniqueAccount !== null && row.account_id === uniqueAccount;
    const signal = sameDate
      ? sameAccount
        ? 'same_amount_date_account'
        : 'same_amount_date'
      : sameAccount
        ? 'same_amount_near_date_account'
        : 'same_amount_near_date';
    const rank = sameDate ? (sameAccount ? 0 : 1) : sameAccount ? 2 : 3;
    ranked.push({
      id: row.id,
      date: row.date,
      amount: row.amount,
      account_id: row.account_id,
      source: row.source,
      type: row.type,
      description: row.description,
      signal,
      rank
    });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Math.min(limit, 10)))
    .map(({ rank, ...candidate }) => candidate);
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

async function main() {
  const inputPath = process.argv.find((arg) => arg.startsWith('--input='))?.slice(8);
  const outputPath = process.argv.find((arg) => arg.startsWith('--out-private='))?.slice(14);
  const expected = Number(
    process.argv.find((arg) => arg.startsWith('--expected-count='))?.slice(17)
  );
  if (!inputPath || !outputPath || !Number.isInteger(expected) || expected <= 0)
    throw new Error(
      'Usage: node scripts/shortcut-candidate-review.mjs --input=private-triage.json --out-private=/private/path/candidates.json --expected-count=1516'
    );
  let triage;
  try {
    triage = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch {
    throw new Error('Invalid triage input');
  }
  if (
    triage?.version !== 1 ||
    !Array.isArray(triage.suggestions) ||
    triage.suggestions.some(
      (item) => typeof item.raw_text !== 'string' || typeof item.kind !== 'string'
    )
  )
    throw new Error('Invalid triage input');
  const [secret, publicEnv] = await Promise.all([
    readFile(resolve(root, '.env.local'), 'utf8').then(env),
    readFile(resolve(root, '../spends-assistant-web/.env.local'), 'utf8').then(env)
  ]);
  const url = publicEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = secret.SUPABASE_SERVICE_ROLE;
  if (!/^https:\/\/[^/]+\.supabase\.co$/u.test(url ?? '') || !key)
    throw new Error('Supabase configuration unavailable');
  const identities = await getRows(
    url,
    key,
    'transactions',
    'select=user_id&deleted_at=is.null&order=id.asc'
  );
  const counts = new Map();
  for (const row of identities) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const owners = [...counts].filter(([, count]) => count === expected);
  if (owners.length !== 1) throw new Error('Confirmed count does not identify one profile');
  const scope = `user_id=eq.${encodeURIComponent(owners[0][0])}`;
  const [ledger, accounts] = await Promise.all([
    getRows(
      url,
      key,
      'transactions',
      `select=id,date,amount,account_id,source,type,description&${scope}&deleted_at=is.null&order=id.asc`
    ),
    getRows(url, key, 'accounts', `select=id,last_four&${scope}&deleted_at=is.null&order=id.asc`)
  ]);
  if (ledger.length !== expected) throw new Error('Active ledger count changed during comparison');
  const review = triage.suggestions
    .filter((item) => financialKinds.has(item.kind))
    .map((item) => {
      const evidence = extractFinancialEvidence(item.raw_text);
      return {
        ...item,
        parsed_evidence: evidence,
        candidates: matchLedgerCandidates(evidence, ledger, accounts)
      };
    });
  const summary = {
    financial_suggestions: review.length,
    with_amount: review.filter((item) => item.parsed_evidence.amount).length,
    with_amount_and_event_date: review.filter(
      (item) => item.parsed_evidence.amount && item.parsed_evidence.date
    ).length,
    with_any_ledger_candidate: review.filter((item) => item.candidates.length).length,
    with_same_amount_date_account: review.filter((item) =>
      item.candidates.some((candidate) => candidate.signal === 'same_amount_date_account')
    ).length,
    without_ledger_candidate: review.filter((item) => !item.candidates.length).length
  };
  await writePrivateReviewFile(outputPath, {
    version: 1,
    source_triage_hash: triage.input_sha256,
    expected_ledger_count: expected,
    summary,
    review,
    warning: 'Read-only suggestions. No candidate is a confirmed duplicate or missing transaction.'
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Candidate review failed'}\n`);
    process.exitCode = 1;
  });
}
