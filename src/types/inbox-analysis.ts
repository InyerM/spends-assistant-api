export type InboxAnalysisState = 'pending' | 'running' | 'ready' | 'blocked' | 'failed' | 'skipped';
export interface InboxAnalysisLease {
  inbox_item_id: string;
  user_id: string;
  lease_token: string;
}
export interface InboxAnalysisJob {
  inbox_item_id: string;
  user_id: string;
  state: InboxAnalysisState;
  attempts: number;
  last_error: string | null;
  available_at: string;
}
export interface InboxAnalysisItem {
  id: string;
  user_id: string;
  source: string;
  status: string;
  raw_text: string;
  received_at: string;
  message_kind?: string;
}
export interface InboxAnalysisProposal {
  status: 'parsed' | 'needs_review';
  merchant: string | null;
  amount: number | null;
  bank_event_at: string | null;
  card_last_four: string | null;
  account_id: string | null;
  category_id: string | null;
  category_source: 'ai' | 'catalog' | 'automation' | 'review_context' | null;
  suggested_type: 'expense' | 'income' | null;
  description: string | null;
  notes: string | null;
  analysis_details: {
    analysis_source: 'ai' | 'automation' | 'history' | 'evidence';
    explanation: string | null;
    event_date: string | null;
    financial_type: 'expense' | 'income' | 'transfer' | null;
    transfer_to_account_id: string | null;
    automation_fields: string[];
    history_fields: string[];
    applied_rules: Array<{ rule_id: string; rule_name: string }>;
    evidence_ids: string[];
  };
}
export interface InboxAnalysisResult extends InboxAnalysisProposal {
  inbox_item_id: string;
  user_id: string;
  analysis_version: number;
}
export interface InboxAnalysisQueueJob {
  kind: 'inbox_analysis';
  inboxItemId: string;
}
