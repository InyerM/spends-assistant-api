export interface UsageTracking {
  id: string;
  user_id: string;
  month: string;
  ai_parses_used: number;
  ai_parses_limit: number;
  transactions_count: number;
  transactions_limit: number;
  created_at: string;
  updated_at: string;
}
