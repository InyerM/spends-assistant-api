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
  return resolveCategoryHistory(
    userId,
    type,
    eventDate,
    categories,
    rows,
    (row) => row.description === merchant
  );
}
function resolveCategoryHistory(
  userId: string,
  type: string,
  eventDate: string,
  categories: Category[],
  rows: ExactCategoryHistory[],
  accepts: (row: ExactCategoryHistory) => boolean
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
      !accepts(row) ||
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
export interface VerifiedContactHistory {
  contactId: string | null;
  ambiguous?: boolean;
  rows: Array<ExactCategoryHistory & { contact_id: string; notes?: string | null }>;
}
export function resolveInboxHistoryCategory(
  userId: string,
  merchant: string,
  type: string,
  eventDate: string,
  categories: Category[],
  exact: ExactCategoryHistory[],
  contact?: VerifiedContactHistory | null
): { categoryId: string; evidenceIds: string[]; contactId?: string } | null {
  if (!contact)
    return resolveExactHistoryCategory(userId, merchant, type, eventDate, categories, exact);
  if (
    contact.ambiguous ||
    !contact.contactId ||
    exact.length >= 13 ||
    contact.rows.length >= 13 ||
    exact.some((row) => row.description !== merchant) ||
    contact.rows.some((row) => row.contact_id !== contact.contactId)
  )
    return null;
  const merged = new Map<string, ExactCategoryHistory>();
  for (const row of [...exact, ...contact.rows]) {
    const previous = merged.get(row.id);
    if (
      previous &&
      (previous.category_id !== row.category_id ||
        previous.user_id !== row.user_id ||
        previous.type !== row.type ||
        previous.date !== row.date)
    )
      return null;
    merged.set(row.id, row);
  }
  const result = resolveCategoryHistory(
    userId,
    type,
    eventDate,
    categories,
    [...merged.values()],
    () => true
  );
  return result
    ? { ...result, ...(contact.rows.length ? { contactId: contact.contactId } : {}) }
    : null;
}
