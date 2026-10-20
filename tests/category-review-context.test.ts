import { expect, it, vi } from 'vitest';
import { CategoryReviewContextService } from '../src/services/supabase/category-review-context.service';
it('loads bounded owner history and excludes the reviewed transaction and empty categories', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json([
      {
        id: 'old',
        description: 'Mercado Libre purchase',
        notes: null,
        category: { name: 'Shopping' }
      }
    ])
  );
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    expect(
      await service.history('owner', 'Mercado Libre — item unverified', 'expense', 'current')
    ).toEqual([
      { id: 'old', description: 'Mercado Libre purchase', notes: null, category: 'Shopping' }
    ]);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('user_id')).toBe('eq.owner');
    expect(url.searchParams.get('id')).toBe('neq.current');
    expect(url.searchParams.get('limit')).toBe('12');
    expect(url.searchParams.get('category.slug')).toContain('uncategorized');
    expect(url.searchParams.get('or')).toContain('mercado');
  } finally {
    vi.unstubAllGlobals();
  }
});
