import { describe, expect, it, vi } from 'vitest';
import { classifyForwardedPurchase } from '../../src/ai/forwarded-purchase-category';
import type { Category } from '../../src/types/category';

const { completeJson } = vi.hoisted(() => ({ completeJson: vi.fn() }));
vi.mock('../../src/ai/openrouter', () => ({ completeJson }));

const categories = [
  { id: 'clothing-id', slug: 'clothing', name: 'Clothing', type: 'expense', is_active: true },
  { id: 'missing-id', slug: 'missing', name: 'Uncategorized', type: 'expense', is_active: true },
  { id: 'wages-id', slug: 'wages', name: 'Wages', type: 'income', is_active: true }
] as Category[];
const usage = { track: vi.fn(async (_params, task) => task({ record: vi.fn() })) };

describe('forwarded purchase category', () => {
  it('accepts only a high-confidence active expense category from the owner taxonomy', async () => {
    completeJson.mockResolvedValue({ data: { category_slug: 'clothing', confidence: 0.98 } });
    expect(
      await classifyForwardedPurchase(
        'SHEIN.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toBe('clothing-id');
    expect(usage.track).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', operation: 'classify_forwarded_purchase' }),
      expect.any(Function)
    );
  });

  it.each([
    { category_slug: 'missing', confidence: 0.99 },
    { category_slug: 'wages', confidence: 0.99 },
    { category_slug: 'unknown', confidence: 0.99 },
    { category_slug: 'clothing', confidence: 0.8 }
  ])('holds an unsupported or uncertain result', async (data) => {
    completeJson.mockResolvedValue({ data });
    expect(
      await classifyForwardedPurchase(
        'SHEIN.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toBeNull();
  });
});
