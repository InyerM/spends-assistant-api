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

export interface AutomationRule {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  prompt_text?: string | null;
  match_phone?: string | null;
  transfer_to_account_id?: string | null;
  conditions: AutomationRuleConditions;
  actions: AutomationRuleActions;
  created_at: string;
  updated_at: string;
}

export interface TransferRuleMatch {
  rule: AutomationRule;
  destinationPhone: string;
  isInternalTransfer: boolean;
}
