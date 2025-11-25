import { BaseService } from './base.service';
import type { Category } from '../../types';

export class CategoriesService extends BaseService {
  async getCategory(slug: string): Promise<Category | null> {
    const categories = await this.fetch<Category[]>(
      `/rest/v1/categories?slug=eq.${slug}&is_active=eq.true&select=*`
    );

    return categories[0] || null;
  }
}
