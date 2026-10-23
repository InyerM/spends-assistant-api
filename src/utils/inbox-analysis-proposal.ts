import type { ForwardedEmailSuggestion } from '../ai/forwarded-email-suggestion';
import type { Account } from '../types/account';
import type { Category } from '../types/category';
import type { AutomationRule } from '../types/rule';
import type { InboxAnalysisItem, InboxAnalysisProposal } from '../types/inbox-analysis';
import type { AutomationRulesService } from '../services/supabase/automation-rules.service';
import type { CreateTransactionInput } from '../types/transaction';
import { extractEmailEventEvidence } from './email-event-evidence';

export function buildInboxAnalysisProposal(
  item: InboxAnalysisItem,
  suggestion: ForwardedEmailSuggestion,
  accounts: Account[],
  categories: Category[],
  rules: AutomationRule[],
  matcher: Pick<AutomationRulesService, 'matchesConditions' | 'findUniqueAccountDetectionRule'>
): InboxAnalysisProposal {
  const evidence = extractEmailEventEvidence(item.raw_text);
  const ownedAccounts = accounts.filter((row) => row.user_id === item.user_id && row.is_active);
  const ownedCategories = categories.filter((row) => row.user_id === item.user_id && row.is_active);
  const activeRules = rules
    .filter((row) => row.user_id === item.user_id && row.is_active)
    .sort((a, b) => b.priority - a.priority);
  const suffix = evidence.sourceLastFour ?? suggestion.sourceLastFour;
  const matches = suffix
    ? ownedAccounts.filter(
        (row) =>
          (!evidence.currency || row.currency === evidence.currency) &&
          (row.identifiers?.length
            ? row.identifiers.some(
                (identifier) => identifier.is_active && identifier.last_four === suffix
              )
            : row.last_four === suffix)
      )
    : [];
  const detected = matcher.findUniqueAccountDetectionRule(
    activeRules.filter((row) => row.rule_type === 'account_detection'),
    item.raw_text
  );
  let accountId =
    ownedAccounts.find((row) => row.id === detected?.actions.set_account)?.id ??
    (matches.length === 1 ? matches[0].id : null);
  let type: 'expense' | 'income' | 'transfer' | null = evidence.type ?? suggestion.type;
  let categoryId =
    ownedCategories.find((row) => row.id === suggestion.categoryId && row.type === type)?.id ??
    null;
  let categorySource: InboxAnalysisProposal['category_source'] = categoryId
    ? suggestion.categorySource
    : null;
  let notes = suggestion.notes?.trim().slice(0, 500) || null;
  let destination: string | null = null;
  const applied: Array<{ rule_id: string; rule_name: string }> = [];
  const fields = new Set<string>();
  for (const rule of activeRules) {
    if (rule.rule_type === 'account_detection') continue;
    const input: Partial<CreateTransactionInput> = {
      description: suggestion.description ?? evidence.merchant ?? '',
      raw_text: item.raw_text,
      source: item.source,
      account_id: accountId ?? '',
      category_id: categoryId ?? undefined,
      transfer_to_account_id: destination ?? undefined,
      amount: suggestion.amount ? Number(suggestion.amount) : undefined,
      ...(type ? { type } : {})
    };
    if (!matcher.matchesConditions(input, rule.conditions, rule.condition_logic ?? 'or')) continue;
    const actions = rule.actions;
    const changed: string[] = [];
    if (actions.set_type) {
      type = actions.set_type;
      changed.push('type');
    }
    if (actions.set_account && ownedAccounts.some((row) => row.id === actions.set_account)) {
      accountId = actions.set_account;
      changed.push('accountId');
    }
    if (actions.set_category === null) {
      categoryId = null;
      categorySource = null;
      changed.push('categoryId');
    } else if (
      actions.set_category &&
      ownedCategories.some((row) => row.id === actions.set_category && row.type === type)
    ) {
      categoryId = actions.set_category;
      categorySource = 'automation';
      changed.push('categoryId');
    }
    const linked = actions.link_to_account ?? rule.transfer_to_account_id;
    if (linked && linked !== accountId && ownedAccounts.some((row) => row.id === linked)) {
      destination = linked;
      type = 'transfer';
      changed.push('transferToAccountId', 'type');
    }
    if (actions.add_note?.trim()) {
      notes = [notes, actions.add_note.trim()].filter(Boolean).join('\n').slice(0, 500);
      changed.push('notes');
    }
    if (changed.length) {
      applied.push({ rule_id: rule.id, rule_name: rule.name.slice(0, 150) });
      changed.forEach((field) => fields.add(field));
    }
  }
  if (
    type === 'transfer' ||
    !ownedCategories.some((row) => row.id === categoryId && row.type === type)
  ) {
    categoryId = null;
    categorySource = null;
  }
  if (type !== 'transfer') destination = null;
  if (evidence.ambiguous) {
    type = null;
    categoryId = null;
    categorySource = null;
    accountId = null;
    destination = null;
  }
  const amount =
    suggestion.amount && Number.isFinite(Number(suggestion.amount)) && Number(suggestion.amount) > 0
      ? Number(suggestion.amount)
      : null;
  const merchant = evidence.merchant?.slice(0, 100) ?? null;
  const description = suggestion.description?.trim().slice(0, 150) || merchant;
  return {
    status:
      !evidence.ambiguous && merchant && amount && suggestion.bankEventAt && suffix
        ? 'parsed'
        : 'needs_review',
    merchant,
    amount,
    bank_event_at: suggestion.bankEventAt,
    card_last_four: suffix,
    account_id: accountId,
    category_id: categoryId,
    category_source: categorySource,
    suggested_type: type === 'expense' || type === 'income' ? type : null,
    description,
    notes,
    analysis_details: {
      analysis_source: applied.length
        ? 'automation'
        : suggestion.evidenceIds?.length
          ? 'history'
          : 'ai',
      explanation: applied.length
        ? `Se aplican tus reglas: ${applied.map((rule) => rule.rule_name).join(', ')}.`.slice(
            0,
            1000
          )
        : (suggestion.explanation ?? null),
      event_date: evidence.date ?? suggestion.eventDate,
      financial_type: type,
      transfer_to_account_id: destination,
      automation_fields: [...fields],
      history_fields: suggestion.evidenceIds?.length
        ? ['categoryId', 'description', ...(notes ? ['notes'] : [])]
        : [],
      applied_rules: applied,
      evidence_ids: suggestion.evidenceIds ?? []
    }
  };
}
