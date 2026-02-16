export interface ParsedExpense {
  amount: number;
  description: string;
  category: string;
  bank: string;
  payment_type: string;
  source: string;
  confidence: number;
  original_date?: string | null;
  original_time?: string | null;
  last_four?: string | null;
  account_type?: 'checking' | 'savings' | 'credit_card' | 'credit' | null;
  is_transaction?: boolean;
  skip_reason?: string | null;
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text: string;
      }>;
    };
    finishReason?: string;
  }>;
}
