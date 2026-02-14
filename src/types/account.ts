export type AccountType = 
  | 'checking' 
  | 'savings' 
  | 'credit_card' 
  | 'cash' 
  | 'investment' 
  | 'crypto'
  | 'credit';

export interface Account {
  id: string;
  user_id: string;
  name: string;
  type: AccountType;
  institution: string | null;
  last_four: string | null;
  currency: string;
  balance: number;
  is_active: boolean;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}
