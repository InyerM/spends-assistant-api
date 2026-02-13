import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoriesService } from '../../../src/services/supabase/categories.service';
import { createMockCategory, createMockFetch } from '../../__test-helpers__/factories';

const URL = 'https://test.supabase.co';
const KEY = 'test-key';

describe('CategoriesService', () => {
  let service: CategoriesService;

  beforeEach(() => {
    service = new CategoriesService(URL, KEY);
    vi.restoreAllMocks();
  });

  describe('getCategory', () => {
    it('returns category when found', async () => {
      const category = createMockCategory({ slug: 'food' });
      vi.stubGlobal('fetch', createMockFetch({ categories: { data: [category] } }));

      const result = await service.getCategory('food');
      expect(result).toEqual(category);
    });

    it('returns null when not found', async () => {
      vi.stubGlobal('fetch', createMockFetch({ categories: { data: [] } }));

      const result = await service.getCategory('nonexistent');
      expect(result).toBeNull();
    });

    it('sends correct query parameters', async () => {
      const mockFn = createMockFetch({ categories: { data: [] } });
      vi.stubGlobal('fetch', mockFn);

      await service.getCategory('food');
      const calledUrl = mockFn.mock.calls[0][0] as string;
      expect(calledUrl).toContain('slug=eq.food');
      expect(calledUrl).toContain('is_active=eq.true');
    });
  });
});
