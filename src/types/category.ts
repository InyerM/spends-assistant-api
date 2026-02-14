export type CategoryType = 'expense' | 'income' | 'transfer';

export interface Category {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  type: 'expense' | 'income' | 'transfer';
  parent_id: string | null;
  icon: string | null;
  color: string | null;
  is_active: boolean;
  created_at: string;
}
