import type {
  AutomationRuleActions,
  AutomationRuleConditions,
  RuleType,
  ConditionLogic
} from '../types/rule';

export interface ExplanationRule {
  name: string;
  rule_type: RuleType;
  condition_logic: ConditionLogic;
  priority: number;
  is_active: boolean;
  managed_account_id: string | null;
  prompt_text: string | null;
  match_phone: string | null;
  transfer_to_account_id: string | null;
  conditions: AutomationRuleConditions;
  actions: AutomationRuleActions;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeExplanationRule(value: unknown): ExplanationRule {
  if (
    !object(value) ||
    typeof value.name !== 'string' ||
    value.name.length > 200 ||
    !object(value.conditions) ||
    !object(value.actions) ||
    JSON.stringify(value).length > 12000
  ) {
    throw new Error('Invalid automation draft');
  }
  const ruleType = value.rule_type ?? 'general';
  const logic = value.condition_logic ?? 'and';
  if (
    !['general', 'account_detection', 'transfer'].includes(String(ruleType)) ||
    !['and', 'or'].includes(String(logic))
  )
    throw new Error('Invalid automation draft');
  return {
    name: value.name.trim(),
    rule_type: ruleType as RuleType,
    condition_logic: logic as ConditionLogic,
    priority: typeof value.priority === 'number' ? value.priority : 0,
    is_active: value.is_active !== false,
    managed_account_id:
      typeof value.managed_account_id === 'string' ? value.managed_account_id : null,
    prompt_text: typeof value.prompt_text === 'string' ? value.prompt_text : null,
    match_phone: typeof value.match_phone === 'string' ? value.match_phone : null,
    transfer_to_account_id:
      typeof value.transfer_to_account_id === 'string' ? value.transfer_to_account_id : null,
    conditions: value.conditions as AutomationRuleConditions,
    actions: value.actions as AutomationRuleActions
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}

export async function explanationFingerprint(
  rule: ExplanationRule,
  accounts: unknown[],
  categories: unknown[]
): Promise<string> {
  const payload = JSON.stringify(canonical({ version: 1, rule, accounts, categories }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
