import { BaseService } from './base.service';
import type { AutomationRule, CreateTransactionInput, AppliedRule } from '../../types';

export class AutomationRulesService extends BaseService {
  async getAutomationRules(userId?: string): Promise<AutomationRule[]> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    return await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&order=priority.desc&select=*${userFilter}`
    );
  }

  /**
   * Get all active prompt texts for dynamic injection into Gemini
   */
  async getActivePrompts(userId?: string): Promise<string[]> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    const rules = await this.fetch<AutomationRule[]>(
      `/rest/v1/automation_rules?is_active=eq.true&deleted_at=is.null&prompt_text=not.is.null&order=priority.desc&select=prompt_text${userFilter}`
    );
    return rules
      .filter(r => r.prompt_text)
      .map(r => r.prompt_text as string);
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
      if (this.matchesConditions(transaction, rule.conditions)) {
        const actions = { ...rule.actions };
        if (rule.transfer_to_account_id && !actions.link_to_account) {
          actions.link_to_account = rule.transfer_to_account_id;
        }
        transaction = this.applyActions(transaction, actions);
        appliedRules.push({
          rule_id: rule.id,
          rule_name: rule.name,
          actions: rule.actions as unknown as Record<string, unknown>,
        });
        console.log(`[Rule Applied] ${rule.name}`);
      }
    }

    if (appliedRules.length > 0) {
      transaction.applied_rules = appliedRules;
    }

    return transaction;
  }

  private matchesConditions(
    transaction: CreateTransactionInput,
    conditions: AutomationRule['conditions']
  ): boolean {
    if (conditions.description_contains) {
      const desc = transaction.description.toLowerCase();
      const matches = conditions.description_contains.some((keyword: string) =>
        desc.includes(keyword.toLowerCase())
      );
      if (!matches) return false;
    }

    if (conditions.description_regex) {
      const regex = new RegExp(conditions.description_regex, 'i');
      if (!regex.test(transaction.description)) return false;
    }

    if (conditions.raw_text_contains) {
      const rawText = (transaction.raw_text ?? '').toLowerCase();
      const matches = conditions.raw_text_contains.some((keyword: string) =>
        rawText.includes(keyword.toLowerCase())
      );
      if (!matches) return false;
    }

    if (conditions.amount_between) {
      const [min, max] = conditions.amount_between;
      if (transaction.amount < min || transaction.amount > max) {
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
      if (!conditions.source.includes(transaction.source)) {
        return false;
      }
    }

    return true;
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
