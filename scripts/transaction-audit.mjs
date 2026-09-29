/** Read-only, redacted audit of the confirmed Supabase profile. Node 20+. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const norm = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const increment = (object, key) => {
  object[key] = (object[key] ?? 0) + 1;
};
const money = (value) => Math.round(Number(value ?? 0) * 100) / 100;
const generic =
  /^(compra|pago|transferencia|transaccion|movimiento|gasto|ingreso|retiro|consignacion|nequi|sin descripcion|payment|purchase)( de| a| por| en)?\s*$/;
const transferHint =
  /\b(transfer|transferencia|transferiste|transfirio|enviaste|envio|pasaste|recarga|fondeo)\b/;
const nequiHint = /\bnequi\b/;
const investmentHint = /\b(tyba|binance|inversion|cripto|crypto|bitcoin|usdt|broker)\b/;
const loanHint = /\b(prestamo|credito|cuota|desembolso|amortizacion)\b/;
const knownSources = new Set([
  'csv_import',
  'sms-shortcut',
  'sms-bulk',
  'web-ai',
  'web',
  'bancolombia_email',
  'manual',
  'telegram',
  'email',
  'api'
]);

export function auditTransactions(rows, accounts, categories) {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const result = {
    examined: rows.length,
    dateRange: { earliest: null, latest: null },
    byYearMonth: {},
    bySource: {},
    byType: {},
    byAccountType: {},
    sourceQuality: {},
    categoryQuality: {
      missing: 0,
      uncategorized: 0,
      inactive: 0,
      missingReference: 0,
      typeMismatch: 0
    },
    accountQuality: {
      missingReference: 0,
      inactive: 0,
      transferWithoutDestination: 0,
      transferSameAccount: 0,
      netMovementWithoutOpeningBalance: []
    },
    descriptionQuality: { empty: 0, generic: 0, short: 0 },
    reviewSignals: {
      nequiRows: 0,
      nequiExpenseRows: 0,
      transferLikeExpense: 0,
      investmentLikeExpense: 0,
      loanLikeIncome: 0,
      loanLikeExpense: 0,
      recurringNequiGroups: 0,
      recurringNequiRows: 0
    },
    duplicateSignals: {
      possiblePairs: 0,
      strongPairs: 0,
      exactRawPairs: 0,
      existingPendingReview: 0,
      existingConfirmed: 0
    },
    metadata: {
      missingConfidence: 0,
      lowConfidence: 0,
      highConfidence: 0,
      reconciled: 0,
      importedRows: 0,
      importedLinked: 0
    }
  };
  const movement = new Map(accounts.map((account) => [account.id, 0]));
  const candidateBuckets = new Map();
  const nequiBuckets = new Map();
  for (const row of rows) {
    increment(result.byYearMonth, String(row.date ?? '').slice(0, 7) || 'unknown');
    const source = knownSources.has(row.source) ? row.source : 'other';
    increment(result.bySource, source);
    increment(result.byType, row.type || 'unknown');
    const sourceQuality = result.sourceQuality[source] ?? {
      missingCategory: 0,
      emptyDescription: 0,
      missingConfidence: 0
    };
    result.sourceQuality[source] = sourceQuality;
    if (row.date && (!result.dateRange.earliest || row.date < result.dateRange.earliest))
      result.dateRange.earliest = row.date;
    if (row.date && (!result.dateRange.latest || row.date > result.dateRange.latest))
      result.dateRange.latest = row.date;
    const description = norm(row.description);
    const context = norm([row.description, row.notes].join(' '));
    if (!description) {
      result.descriptionQuality.empty++;
      sourceQuality.emptyDescription++;
    }
    if (generic.test(description)) result.descriptionQuality.generic++;
    if (description.length > 0 && description.length < 8) result.descriptionQuality.short++;
    const category = row.category_id ? categoryMap.get(row.category_id) : null;
    if (!row.category_id) {
      result.categoryQuality.missing++;
      sourceQuality.missingCategory++;
    } else if (!category) result.categoryQuality.missingReference++;
    else {
      if (category.slug === 'missing' || category.slug === 'uncategorized')
        result.categoryQuality.uncategorized++;
      if (category.is_active === false || category.deleted_at) result.categoryQuality.inactive++;
      if (category.type !== row.type) result.categoryQuality.typeMismatch++;
    }
    const account = accountMap.get(row.account_id);
    if (!account) result.accountQuality.missingReference++;
    else if (account.is_active === false || account.deleted_at) result.accountQuality.inactive++;
    increment(result.byAccountType, account?.type || 'missing');
    const amount = money(row.amount);
    if (row.type === 'expense')
      movement.set(row.account_id, money((movement.get(row.account_id) ?? 0) - amount));
    if (row.type === 'income')
      movement.set(row.account_id, money((movement.get(row.account_id) ?? 0) + amount));
    if (row.type === 'transfer') {
      movement.set(row.account_id, money((movement.get(row.account_id) ?? 0) - amount));
      if (row.transfer_to_account_id)
        movement.set(
          row.transfer_to_account_id,
          money((movement.get(row.transfer_to_account_id) ?? 0) + amount)
        );
      else result.accountQuality.transferWithoutDestination++;
      if (row.transfer_to_account_id === row.account_id)
        result.accountQuality.transferSameAccount++;
    }
    if (nequiHint.test(norm([context, row.raw_text].join(' ')))) {
      result.reviewSignals.nequiRows++;
      if (row.type === 'expense') result.reviewSignals.nequiExpenseRows++;
      const bucketKey = `${description}|${amount}|${row.type}`;
      const bucket = nequiBuckets.get(bucketKey) ?? [];
      bucket.push(row);
      nequiBuckets.set(bucketKey, bucket);
    }
    if (row.type === 'expense' && transferHint.test(context))
      result.reviewSignals.transferLikeExpense++;
    if (row.type === 'expense' && investmentHint.test(context))
      result.reviewSignals.investmentLikeExpense++;
    if (row.type === 'income' && loanHint.test(context)) result.reviewSignals.loanLikeIncome++;
    if (row.type === 'expense' && loanHint.test(context)) result.reviewSignals.loanLikeExpense++;
    if (row.confidence == null) {
      result.metadata.missingConfidence++;
      sourceQuality.missingConfidence++;
    } else if (Number(row.confidence) < 70) result.metadata.lowConfidence++;
    else if (Number(row.confidence) >= 90) result.metadata.highConfidence++;
    if (row.is_reconciled) result.metadata.reconciled++;
    if (row.source === 'csv_import') {
      result.metadata.importedRows++;
      if (row.import_id) result.metadata.importedLinked++;
    }
    if (row.duplicate_status === 'pending_review') result.duplicateSignals.existingPendingReview++;
    if (row.duplicate_status === 'confirmed') result.duplicateSignals.existingConfirmed++;
    const key = `${row.date}|${row.account_id}|${amount}`;
    const bucket = candidateBuckets.get(key) ?? [];
    bucket.push(row);
    candidateBuckets.set(key, bucket);
  }
  for (const bucket of candidateBuckets.values()) {
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < bucket.length; j++) {
        const first = bucket[i],
          second = bucket[j];
        const exactRaw = Boolean(
          first.raw_text && second.raw_text && norm(first.raw_text) === norm(second.raw_text)
        );
        const sameDescription = Boolean(
          norm(first.description) && norm(first.description) === norm(second.description)
        );
        const sameTime = Boolean(first.time && second.time && first.time === second.time);
        if (exactRaw) result.duplicateSignals.exactRawPairs++;
        if (exactRaw || (sameDescription && sameTime && first.source === second.source))
          result.duplicateSignals.strongPairs++;
        else result.duplicateSignals.possiblePairs++;
      }
  }
  for (const bucket of nequiBuckets.values()) {
    const dates = [...new Set(bucket.map((row) => row.date))].sort();
    if (dates.length < 3) continue;
    const intervals = dates
      .slice(1)
      .map((date, index) => (Date.parse(date) - Date.parse(dates[index])) / 86400000);
    if (intervals.filter((days) => days >= 25 && days <= 35).length >= 2) {
      result.reviewSignals.recurringNequiGroups++;
      result.reviewSignals.recurringNequiRows += bucket.length;
    }
  }
  result.accountQuality.netMovementWithoutOpeningBalance = accounts.map((account) => ({
    accountType: account.type,
    movement: money(movement.get(account.id)),
    reportedBalance: money(account.balance),
    reconciled: false
  }));
  return result;
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

async function getRows(url, key, table, query, pageSize = 500) {
  const output = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(
      `${url}/rest/v1/${table}?${query}&limit=${pageSize}&offset=${offset}`,
      {
        method: 'GET',
        headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
      }
    );
    if (!response.ok) throw new Error(`Read-only ${table} request failed (${response.status})`);
    const page = await response.json();
    output.push(...page);
    if (page.length < pageSize) return output;
  }
}

function redacted(result) {
  const { netMovementWithoutOpeningBalance, ...accountQuality } = result.accountQuality;
  return {
    ...result,
    accountQuality: {
      ...accountQuality,
      accountsExamined: netMovementWithoutOpeningBalance.length,
      reportedBalanceCannotBeVerified: netMovementWithoutOpeningBalance.length
      // Opening balances, transfers outside this account set, and soft deletions prevent a sound balance comparison.
    }
  };
}

async function main() {
  const expected = Number(
    process.argv.find((arg) => arg.startsWith('--expected-count='))?.split('=')[1]
  );
  if (!Number.isInteger(expected) || expected <= 0)
    throw new Error('Supply --expected-count with the confirmed active-row count');
  const secretEnv = readEnv(
    await readFile(
      '/Users/inyermarin/Developer/personal/spends-assistant/spends/.env.local',
      'utf8'
    )
  );
  const urlEnv = readEnv(
    await readFile(
      '/Users/inyermarin/Developer/personal/spends-assistant/spends-assistant-web/.env.local',
      'utf8'
    )
  );
  const url = urlEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = secretEnv.SUPABASE_SERVICE_ROLE;
  if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url ?? '') || !key)
    throw new Error('Supabase configuration unavailable');
  const identities = await getRows(
    url,
    key,
    'transactions',
    'select=user_id&deleted_at=is.null&order=id.asc'
  );
  const counts = new Map();
  for (const row of identities) counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1);
  const matches = [...counts].filter(([, count]) => count === expected);
  if (matches.length !== 1)
    throw new Error(
      'Confirmed count does not identify exactly one profile; stop for ownership review'
    );
  const userId = matches[0][0];
  const scope = `user_id=eq.${encodeURIComponent(userId)}`;
  const rows = await getRows(
    url,
    key,
    'transactions',
    `select=*&${scope}&deleted_at=is.null&order=id.asc`
  );
  if (rows.length !== expected)
    throw new Error('Active-row count changed during audit; rerun after ownership review');
  const [accounts, categories] = await Promise.all([
    getRows(
      url,
      key,
      'accounts',
      `select=id,type,balance,is_active,deleted_at&${scope}&order=id.asc`
    ),
    getRows(
      url,
      key,
      'categories',
      `select=id,type,slug,is_active,deleted_at&${scope}&order=id.asc`
    )
  ]);
  const report = redacted(auditTransactions(rows, accounts, categories));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
