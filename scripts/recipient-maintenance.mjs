/** Apply an owner-reviewed private category and automation-rule plan with live preconditions. */
import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function categoryEditStatus(row, edit, ownerId) {
  if (!row || row.id !== edit.id || row.user_id !== ownerId ||
    row.type !== edit.expected.type || Number(row.amount) !== Number(edit.expected.amount) ||
    createHash('sha256').update(row.raw_text ?? '').digest('hex') !== edit.expected.raw_sha256)
    return 'conflict';
  if (row.category_id === edit.category_id) return 'done';
  if (row.category_id !== edit.expected.category_id ||
    row.updated_at !== edit.expected.updated_at) return 'conflict';
  return 'pending';
}

/** Mirror the relevant deterministic conditions before inserting a raw-message rule. */
export function matchesPlannedRule(rule, row) {
  const conditions = rule.conditions ?? {};
  if (conditions.raw_text_contains) {
    const raw = (row.raw_text ?? '').toLowerCase();
    const keywords = conditions.raw_text_contains;
    const matched = rule.condition_logic === 'and'
      ? keywords.every((keyword) => raw.includes(keyword.toLowerCase()))
      : keywords.some((keyword) => raw.includes(keyword.toLowerCase()));
    if (!matched) return false;
  }
  if (conditions.description_contains) {
    const description = (row.description ?? '').toLowerCase();
    const keywords = conditions.description_contains;
    const matched = rule.condition_logic === 'and'
      ? keywords.every((keyword) => description.includes(keyword.toLowerCase()))
      : keywords.some((keyword) => description.includes(keyword.toLowerCase()));
    if (!matched) return false;
  }
  if (conditions.description_regex &&
    !new RegExp(conditions.description_regex, 'i').test(row.description ?? '')) return false;
  if (conditions.source && !conditions.source.includes(row.source)) return false;
  if (conditions.amount_between &&
    (Number(row.amount) < conditions.amount_between[0] ||
      Number(row.amount) > conditions.amount_between[1])) return false;
  if (conditions.amount_equals !== undefined &&
    Number(row.amount) !== Number(conditions.amount_equals)) return false;
  if (conditions.from_account && row.account_id !== conditions.from_account) return false;
  return true;
}

function env(content) {
  return Object.fromEntries(content.split(/\r?\n/u)
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split).trim(), line.slice(split + 1).trim().replace(/^['"]|['"]$/gu, '')];
    }));
}

async function request(url, key, path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  });
  if (!response.ok) throw new Error(`Supabase ${options.method ?? 'GET'} ${path.split('?')[0]} failed (${response.status})`);
  return await response.json();
}

async function getRows(url, key, table, query) {
  const output = [];
  for (let offset = 0; ; offset += 500) {
    const page = await request(url, key, `${table}?${query}&limit=500&offset=${offset}`);
    output.push(...page);
    if (page.length < 500) return output;
  }
}

function assertCategory(category, ownerId, type = 'expense') {
  if (!category || category.user_id !== ownerId || category.type !== type ||
    !category.is_active || category.deleted_at !== null)
    throw new Error('Planned category is unavailable to the confirmed owner');
}

function sameNewRule(existing, planned) {
  return existing.user_id === planned.user_id && existing.name === planned.name &&
    existing.is_active === planned.is_active && existing.priority === planned.priority &&
    existing.rule_type === planned.rule_type && existing.condition_logic === planned.condition_logic &&
    isDeepStrictEqual(existing.conditions, planned.conditions) &&
    isDeepStrictEqual(existing.actions, planned.actions);
}

async function openPrivateAudit(path) {
  if (!isAbsolute(path)) throw new Error('Audit path must be absolute');
  const destination = resolve(path);
  const inside = relative(root, destination);
  if (!inside.startsWith('..') && inside !== '..')
    throw new Error('Audit path must be outside the repository');
  const parent = await stat(dirname(destination));
  if ((parent.mode & 0o077) !== 0) throw new Error('Audit directory must be owner-only');
  return await open(destination, 'wx', 0o600);
}

async function main() {
  const planPath = process.argv.find((arg) => arg.startsWith('--plan='))?.slice(7);
  const auditPath = process.argv.find((arg) => arg.startsWith('--audit='))?.slice(8);
  const apply = process.argv.includes('--apply');
  if (!planPath || (apply && !auditPath))
    throw new Error('Usage: node scripts/recipient-maintenance.mjs --plan=/private/plan.json [--apply --audit=/private/audit.jsonl]');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.version !== 1 || !Number.isInteger(plan.expected_active_transactions) ||
    !Array.isArray(plan.edits) || !Array.isArray(plan.rules) ||
    !Array.isArray(plan.rule_updates) || typeof plan.user_id !== 'string')
    throw new Error('Invalid private maintenance plan');
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
  const confirmed = [...counts].filter(([, count]) => count === plan.expected_active_transactions);
  if (confirmed.length !== 1 || confirmed[0][0] !== plan.user_id)
    throw new Error('Active ledger count no longer confirms the planned owner');
  const scope = `user_id=eq.${encodeURIComponent(plan.user_id)}&deleted_at=is.null`;
  const [transactions, categories, rules] = await Promise.all([
    getRows(url, key, 'transactions', `select=*&${scope}`),
    getRows(url, key, 'categories', `select=*&${scope}`),
    getRows(url, key, 'automation_rules', `select=*&${scope}`)
  ]);
  if (transactions.length !== plan.expected_active_transactions)
    throw new Error('Ledger changed during maintenance preflight');
  const byTransaction = new Map(transactions.map((row) => [row.id, row]));
  const byCategory = new Map(categories.map((row) => [row.id, row]));
  const seenIds = new Set();
  const pendingEdits = [];
  for (const edit of plan.edits) {
    if (seenIds.has(edit.id)) throw new Error('Duplicate planned transaction edit');
    seenIds.add(edit.id);
    assertCategory(byCategory.get(edit.category_id), plan.user_id);
    const status = categoryEditStatus(byTransaction.get(edit.id), edit, plan.user_id);
    if (status === 'conflict') throw new Error(`Transaction precondition changed (${edit.alias})`);
    if (status === 'pending') pendingEdits.push(edit);
  }
  const newRules = [];
  for (const planned of plan.rules) {
    if (planned.user_id !== plan.user_id || planned.rule_type !== 'general' ||
      planned.condition_logic !== 'and' || !planned.is_active ||
      !Array.isArray(planned.conditions?.raw_text_contains) ||
      planned.conditions.raw_text_contains.length < 2 ||
      Object.keys(planned.actions ?? {}).join(',') !== 'set_category')
      throw new Error('Only narrow general category rules are supported');
    assertCategory(byCategory.get(planned.actions.set_category), plan.user_id);
    const existing = rules.filter((rule) => rule.name === planned.name);
    if (existing.length > 1 || (existing.length === 1 && !sameNewRule(existing[0], planned)))
      throw new Error(`Automation rule name collision (${planned.alias})`);
    if (existing.length === 0) newRules.push(planned);
  }
  const pendingRuleUpdates = [];
  for (const update of plan.rule_updates) {
    const existing = rules.find((rule) => rule.id === update.id);
    if (!existing || existing.user_id !== plan.user_id ||
      !isDeepStrictEqual(existing.actions, update.expected_actions))
      throw new Error(`Existing rule changed (${update.alias})`);
    if (isDeepStrictEqual(existing.conditions, update.conditions) &&
      existing.condition_logic === update.condition_logic) continue;
    if (existing.updated_at !== update.expected_updated_at ||
      !isDeepStrictEqual(existing.conditions, update.expected_conditions))
      throw new Error(`Existing rule precondition changed (${update.alias})`);
    pendingRuleUpdates.push(update);
  }
  for (const planned of [...newRules, ...pendingRuleUpdates.map((update) => ({
    ...rules.find((rule) => rule.id === update.id), ...update
  }))]) {
    const matches = transactions.filter((row) => matchesPlannedRule(planned, row));
    if (matches.length === 0) throw new Error(`Planned rule has no historical match (${planned.alias})`);
    const conflict = matches.some((row) => rules.some((rule) =>
      rule.is_active && rule.id !== planned.id && rule.actions?.set_category &&
      rule.actions.set_category !== planned.actions?.set_category &&
      matchesPlannedRule(rule, row)));
    if (conflict) throw new Error(`Planned rule conflicts with an active category rule (${planned.alias})`);
  }
  const summary = {
    pending_category_edits: pendingEdits.length,
    already_applied_category_edits: plan.edits.length - pendingEdits.length,
    new_rules: newRules.length,
    rule_updates: pendingRuleUpdates.length
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  const audit = await openPrivateAudit(auditPath);
  const append = async (item) => audit.appendFile(`${JSON.stringify(item)}\n`);
  try {
    await append({ phase: 'preflight', at: new Date().toISOString(),
      plan_sha256: createHash('sha256').update(await readFile(planPath)).digest('hex'), summary });
    for (const edit of pendingEdits) {
      const previous = edit.expected.category_id === null
        ? 'category_id=is.null' : `category_id=eq.${encodeURIComponent(edit.expected.category_id)}`;
      const query = `id=eq.${edit.id}&user_id=eq.${plan.user_id}&deleted_at=is.null&` +
        `type=eq.${edit.expected.type}&updated_at=eq.${encodeURIComponent(edit.expected.updated_at)}&${previous}`;
      const changed = await request(url, key, `transactions?${query}`, {
        method: 'PATCH', body: JSON.stringify({ category_id: edit.category_id })
      });
      if (changed.length !== 1 || changed[0].category_id !== edit.category_id)
        throw new Error(`Conditional category update failed (${edit.alias})`);
      await append({ phase: 'category_edit', alias: edit.alias, id: edit.id,
        from: edit.expected.category_id, to: edit.category_id });
    }
    for (const update of pendingRuleUpdates) {
      const changed = await request(url, key,
        `automation_rules?id=eq.${update.id}&user_id=eq.${plan.user_id}&updated_at=eq.${encodeURIComponent(update.expected_updated_at)}`, {
          method: 'PATCH', body: JSON.stringify({
            conditions: update.conditions, condition_logic: update.condition_logic
          })
        });
      if (changed.length !== 1 || !isDeepStrictEqual(changed[0].conditions, update.conditions))
        throw new Error(`Conditional rule update failed (${update.alias})`);
      await append({ phase: 'rule_update', alias: update.alias, id: update.id });
    }
    for (const planned of newRules) {
      const { alias, ...payload } = planned;
      const created = await request(url, key, 'automation_rules', {
        method: 'POST', body: JSON.stringify(payload)
      });
      if (created.length !== 1 || !sameNewRule(created[0], payload))
        throw new Error(`Rule creation verification failed (${alias})`);
      await append({ phase: 'rule_create', alias, id: created[0].id });
    }
    await append({ phase: 'complete', at: new Date().toISOString(), summary });
    process.stdout.write(`${JSON.stringify({ ...summary, applied: true })}\n`);
  } finally {
    await audit.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Maintenance failed'}\n`);
    process.exitCode = 1;
  });
}
