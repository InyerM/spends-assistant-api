import type { Category } from '../types/category';
export interface ExactCategoryHistory {
  id: string;
  user_id: string;
  description: string;
  type: string;
  date: string;
  category_id: string;
}
/** Classification only: all bounded exact observations must agree within 180 days. */
export function resolveExactHistoryCategory(
  userId: string,
  merchant: string,
  type: string,
  eventDate: string,
  categories: Category[],
  rows: ExactCategoryHistory[]
): { categoryId: string; evidenceIds: string[] } | null {
  const event = Date.parse(eventDate);
  if (!Number.isFinite(event) || rows.length < 2 || rows.length >= 13) return null;
  const ids = new Set<string>();
  const categoryId = rows[0].category_id;
  if (
    !categories.some(
      (category) =>
        category.id === categoryId &&
        category.user_id === userId &&
        category.is_active &&
        category.type === type &&
        !['uncategorized', 'uncategorized-income', 'missing'].includes(category.slug)
    )
  )
    return null;
  for (const row of rows) {
    const date = Date.parse(row.date);
    if (
      !row.id ||
      ids.has(row.id) ||
      row.user_id !== userId ||
      row.description !== merchant ||
      row.type !== type ||
      row.category_id !== categoryId ||
      !Number.isFinite(date) ||
      date > event ||
      event - date > 180 * 86400000
    )
      return null;
    ids.add(row.id);
  }
  return { categoryId, evidenceIds: [...ids] };
}
