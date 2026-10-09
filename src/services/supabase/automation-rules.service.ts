import { BaseService } from './base.service';
import type {
  AutomationRule,
  AutomationRuleConditions,
  CreateTransactionInput,
  AppliedRule,
  Account
} from '../../types';
import type { ConditionLogic } from '../../types/rule';

export interface CreateRuleInput {
  user_id: string;
  name: string;
  is_active: boolean;
  priority: number;
  rule_type: string;
  condition_logic: string;
  conditions: AutomationRuleConditions;
  actions: AutomationRule['actions'];
}

export class AutomationRulesService extends BaseService {
  async getExplanation(
    userId: string,
    fingerprint: string,
    locale: string
  ): Promise<string | null> {
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      fingerprint: `eq.${fingerprint}`,
      locale: `eq.${locale}`,
      select: 'explanation',
      limit: '1'
    });
    const rows = await this.fetch<{ explanation: string }[]>(
      `/rest/v1/automation_rule_explanations?${params}`
    );
    return rows[0]?.explanation ?? null;
  }

  async saveExplanation(
    userId: string,
    fingerprint: string,
    locale: string,
    explanation: string
  ): Promise<void> {
    await this.fetch(
      '/rest/v1/automation_rule_explanations?on_conflict=user_id,fingerprint,locale',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: userId, fingerprint, locale, explanation })
      }
    );
  }

  async getAutomationRules(userId?: string): Promise<AutomationRule[]> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    return await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&order=priority.desc&select=*${userFilter}`
    );
  }

  /**
   * Get only account_detection rules for pre-parse evaluation
   */
  async getAccountDetectionRules(userId: string): Promise<AutomationRule[]> {
    return await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&rule_type=eq.account_detection&user_id=eq.${userId}&order=priority.desc&select=*`
    );
  }

  findUniqueAccountDetectionRule(rules: AutomationRule[], rawText: string): AutomationRule | null {
    let matchedRule: AutomationRule | null = null;
    for (const rule of rules) {
      if (
        !rule.actions.set_account ||
        !this.matchesConditions(
          { raw_text: rawText },
          rule.conditions,
          rule.condition_logic ?? 'or'
        )
      )
        continue;
      if (matchedRule && matchedRule.actions.set_account !== rule.actions.set_account) return null;
      matchedRule ??= rule;
    }
    return matchedRule;
  }

  /**
   * Get all active prompt texts for dynamic injection into the parser model
   */
  async getActivePrompts(userId?: string): Promise<string[]> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    const rules = await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&prompt_text=not.is.null&order=priority.desc&select=prompt_text${userFilter}`
    );
    return rules.filter((r) => r.prompt_text).map((r) => r.prompt_text as string);
  }

  /**
   * Find a transfer rule by matching phone number
   */
  async findTransferRule(phoneNumber: string, userId?: string): Promise<AutomationRule | null> {
    // Normalize phone number (remove leading * if present)
    const normalizedPhone = phoneNumber.replace(/^\*/, '');
    const userFilter = userId ? `&user_id=eq.${userId}` : '';

    const rules = await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&match_phone=eq.${normalizedPhone}&select=*${userFilter}`
    );

    return rules.length > 0 ? rules[0] : null;
  }

  /**
   * Get all transfer rules with phone matching
   */
  async getTransferRules(userId?: string): Promise<AutomationRule[]> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    return await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&match_phone=not.is.null&order=priority.desc&select=*${userFilter}`
    );
  }

  async applyAutomationRules(
    transaction: CreateTransactionInput,
    userId?: string
  ): Promise<CreateTransactionInput> {
    const rules = await this.getAutomationRules(userId);
    const appliedRules: AppliedRule[] = [];

    for (const rule of rules) {
      // Skip account_detection rules during post-parse application
      if (rule.rule_type === 'account_detection') continue;

      const logic = rule.condition_logic ?? 'or';
      if (this.matchesConditions(transaction, rule.conditions, logic)) {
        const actions = { ...rule.actions };
        if (rule.transfer_to_account_id && !actions.link_to_account) {
          actions.link_to_account = rule.transfer_to_account_id;
        }
        transaction = this.applyActions(transaction, actions);
        appliedRules.push({
          rule_id: rule.id,
          rule_name: rule.name,
          actions: rule.actions as unknown as Record<string, unknown>
        });
        console.log(`[Rule Applied] ${rule.name}`);
      }
    }

    if (appliedRules.length > 0) {
      transaction.applied_rules = appliedRules;
    }

    return transaction;
  }

  /**
   * Match conditions against a transaction or raw text, supporting AND/OR logic.
   * For array conditions (description_contains, raw_text_contains):
   *   - 'or' (default): any keyword matches → condition passes
   *   - 'and': all keywords must match → condition passes
   * Non-array conditions are always exact match.
   */
  matchesConditions(
    transaction: Partial<CreateTransactionInput>,
    conditions: AutomationRuleConditions,
    logic: ConditionLogic = 'or'
  ): boolean {
    if (conditions.description_contains) {
      const desc = (transaction.description ?? '').toLowerCase();
      const matchFn =
        logic === 'and'
          ? conditions.description_contains.every((keyword: string) =>
              desc.includes(keyword.toLowerCase())
            )
          : conditions.description_contains.some((keyword: string) =>
              desc.includes(keyword.toLowerCase())
            );
      if (!matchFn) return false;
    }

    if (conditions.description_regex) {
      const regex = new RegExp(conditions.description_regex, 'i');
      if (!regex.test(transaction.description ?? '')) return false;
    }

    if (conditions.raw_text_contains) {
      const rawText = (transaction.raw_text ?? '').toLowerCase();
      const matchFn =
        logic === 'and'
          ? conditions.raw_text_contains.every((keyword: string) =>
              rawText.includes(keyword.toLowerCase())
            )
          : conditions.raw_text_contains.some((keyword: string) =>
              rawText.includes(keyword.toLowerCase())
            );
      if (!matchFn) return false;
    }

    if (conditions.amount_between) {
      const [min, max] = conditions.amount_between;
      if (
        transaction.amount === undefined ||
        transaction.amount < min ||
        transaction.amount > max
      ) {
        return false;
      }
    }

    if (conditions.amount_equals !== undefined) {
      if (transaction.amount !== conditions.amount_equals) {
        return false;
      }
    }

    if (conditions.from_account) {
      if (transaction.account_id !== conditions.from_account) {
        return false;
      }
    }

    if (conditions.source) {
      if (!transaction.source || !conditions.source.includes(transaction.source)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate account detection rules from active accounts.
   * Returns the rules as a preview (not yet inserted).
   */
  generateAccountRules(userId: string, accounts: Account[]): CreateRuleInput[] {
    const rules: CreateRuleInput[] = [];

    for (const account of accounts) {
      if (account.type === 'cash') continue;
      if (!account.is_active) continue;

      const suffixes = account.identifiers?.length
        ? account.identifiers
            .filter((identifier) => identifier.is_active)
            .map((identifier) => identifier.last_four)
        : account.last_four
          ? [account.last_four]
          : [];
      for (const suffix of suffixes.length ? [...new Set(suffixes)] : ['']) {
        const keywords = [account.institution, suffix].filter(Boolean) as string[];
        if (keywords.length === 0) continue;
        rules.push({
          user_id: userId,
          name: `Account: ${account.name}${suffix ? ` *${suffix}` : ''}`,
          is_active: true,
          priority: 100,
          rule_type: 'account_detection',
          condition_logic: 'and',
          conditions: { raw_text_contains: keywords },
          actions: { set_account: account.id }
        });
      }
    }

    return rules;
  }

  /**
   * Create a single rule, optionally including the AI prompt that generated it.
   */
  async createRuleWithPrompt(
    rule: CreateRuleInput & { ai_prompt?: string }
  ): Promise<AutomationRule> {
    const results = await this.fetch<AutomationRule[]>('/rest/v1/automation_rules', {
      method: 'POST',
      body: JSON.stringify(rule)
    });
    return results[0];
  }

  /**
   * Bulk create automation rules.
   */
  async bulkCreateRules(rules: CreateRuleInput[]): Promise<AutomationRule[]> {
    if (rules.length === 0) return [];

    return await this.fetch<AutomationRule[]>('/rest/v1/automation_rules', {
      method: 'POST',
      body: JSON.stringify(rules)
    });
  }

  private applyActions(
    transaction: CreateTransactionInput,
    actions: AutomationRule['actions']
  ): CreateTransactionInput {
    if (actions.set_type) {
      transaction.type = actions.set_type;
    }

    if (actions.set_category !== undefined) {
      transaction.category_id = actions.set_category || undefined;
    }

    if (actions.set_account) {
      transaction.account_id = actions.set_account;
    }

    if (actions.link_to_account) {
      transaction.transfer_to_account_id = actions.link_to_account;
      transaction.transfer_id = crypto.randomUUID();
    }

    if (actions.add_note) {
      transaction.notes = transaction.notes
        ? `${transaction.notes}\n${actions.add_note}`
        : actions.add_note;
    }

    return transaction;
  }
}
