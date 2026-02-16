import { TransactionType } from './transaction';

export interface AutomationRuleConditions {
  description_contains?: string[];
  description_regex?: string;
  raw_text_contains?: string[];
  amount_between?: [number, number];
  amount_equals?: number;
  from_account?: string;
  to_account?: string;
  source?: string[];
  category?: string;
}

export interface AutomationRuleActions {
  set_type?: TransactionType;
  set_category?: string | null;
  set_account?: string;
  link_to_account?: string;
  auto_reconcile?: boolean;
  add_note?: string;
}

export type RuleType = 'general' | 'account_detection' | 'transfer';
export type ConditionLogic = 'and' | 'or';

export interface AutomationRule {
  id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  priority: number;
  prompt_text?: string | null;
  match_phone?: string | null;
  transfer_to_account_id?: string | null;
  rule_type: RuleType;
  condition_logic: ConditionLogic;
  conditions: AutomationRuleConditions;
  actions: AutomationRuleActions;
  ai_prompt?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransferRuleMatch {
  rule: AutomationRule;
  destinationPhone: string;
  isInternalTransfer: boolean;
}
