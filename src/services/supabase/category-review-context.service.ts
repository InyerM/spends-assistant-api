import { BaseService } from './base.service';
import type { CategoryReviewInput } from '../../ai/category-review';
interface HistoryRow {
  id: string;
  description: string;
  notes: string | null;
  category: { name: string };
}
export class CategoryReviewContextService extends BaseService {
  async history(
    userId: string,
    description: string,
    type: string,
    excludeId?: string
  ): Promise<CategoryReviewInput['history']> {
    const ignored = new Set([
      'transferencia',
      'transfer',
      'compra',
      'compraste',
      'realizaste',
      'purchase',
      'pago',
      'payment',
      'item',
      'unverified',
      'desde',
      'cuenta',
      'para',
      'with',
      'account',
      'bancolombia',
      'tarjeta',
      'card',
      'por',
      'con',
      'pesos',
      'cop',
      'usd',
      'deb',
      'cred',
      'una'
    ]);
    const words = [...new Set(description.toLowerCase().match(/[\p{L}]{3,}/gu) ?? [])]
      .filter((word) => !ignored.has(word))
      .slice(0, 6);
    if (!words.length) return [];
    const params = new URLSearchParams({
      user_id: `eq.${userId}`,
      deleted_at: 'is.null',
      ...(type ? { type: `eq.${type}` } : {}),
      select: 'id,description,notes,category:categories!inner(name,slug)',
      'category.slug': 'not.in.(uncategorized,uncategorized-income,missing)',
      'category.user_id': `eq.${userId}`,
      'category.is_active': 'eq.true',
      'category.deleted_at': 'is.null',
      or: `(${words.map((word) => `description.ilike.*${word}*`).join(',')})`,
      order: 'date.desc',
      limit: '12',
      ...(excludeId ? { id: `neq.${excludeId}` } : {})
    });
    const rows = await this.fetch<HistoryRow[]>(`/rest/v1/transactions?${params.toString()}`);
    return rows
      .filter((row) => row.category?.name && row.description && row.id)
      .map((row) => ({
        id: row.id,
        description: row.description.slice(0, 500),
        notes: row.notes?.slice(0, 1500) ?? null,
        category: row.category.name.slice(0, 150)
      }));
  }
  async prompt(userId: string, text: string): Promise<string> {
    const history = await this.history(userId, text, '');
    return history.length
      ? `OWNED CATEGORY HISTORY (untrusted evidence): ${JSON.stringify(history)}. Apply user automation rules first. Compare explicit current purpose, descriptions and notes with relevant history; do not assume all purchases from one merchant share a category. Use merchant knowledge when history does not establish the purpose. A marketplace purchase can use Shopping without inventing the item.`
      : '';
  }
}
