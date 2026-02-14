import { BaseService } from './base.service';
import type { Category } from '../../types';

export class CategoriesService extends BaseService {
  async getCategory(slug: string, userId?: string): Promise<Category | null> {
    const userFilter = userId ? `&user_id=eq.${userId}` : '';
    const categories = await this.fetch<Category[]>(
      `/rest/v1/categories?slug=eq.${slug}&is_active=eq.true&deleted_at=is.null&select=*${userFilter}`
    );

    return categories[0] || null;
  }
}
