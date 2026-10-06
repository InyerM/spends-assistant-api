import { describe, expect, it, vi } from 'vitest';
import { classifyForwardedPurchase } from '../../src/ai/forwarded-purchase-category';
import type { Category } from '../../src/types/category';

const { completeJson } = vi.hoisted(() => ({ completeJson: vi.fn() }));
vi.mock('../../src/ai/openrouter', () => ({ completeJson }));

const categories = [
  { id: 'clothing-id', slug: 'clothing', name: 'Clothing', type: 'expense', is_active: true },
  { id: 'shopping-id', slug: 'shopping', name: 'Shopping', type: 'expense', is_active: true },
  { id: 'missing-id', slug: 'missing', name: 'Uncategorized', type: 'expense', is_active: true },
  {
    id: 'uncategorized-id',
    slug: 'uncategorized',
    name: 'Uncategorized',
    type: 'expense',
    is_active: true
  },
  { id: 'others-id', slug: 'others', name: 'Others', type: 'expense', is_active: true },
  { id: 'wages-id', slug: 'wages', name: 'Wages', type: 'income', is_active: true }
] as Category[];
const usage = { track: vi.fn(async (_params, task) => task({ record: vi.fn() })) };

describe('forwarded purchase category', () => {
  it('accepts only a high-confidence active expense category from the owner taxonomy', async () => {
    completeJson.mockResolvedValue({
      data: { category_slug: 'clothing', confidence: 0.98, merchant_type: 'specialist' }
    });
    expect(
      await classifyForwardedPurchase(
        'SHEIN.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toEqual({ categoryId: 'clothing-id', model: 'model' });
    expect(usage.track).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', operation: 'classify_forwarded_purchase' }),
      expect.any(Function)
    );
  });

  it('classifies a general marketplace as shopping without guessing the purchased item', async () => {
    completeJson.mockResolvedValue({
      data: { category_slug: 'shopping', confidence: 0.95, merchant_type: 'marketplace' }
    });
    expect(
      await classifyForwardedPurchase(
        'AMAZON.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toEqual({ categoryId: 'shopping-id', model: 'model' });
    expect(completeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('Amazon.com is a general marketplace'),
        user: expect.stringContaining('AMAZON.COM')
      })
    );
  });

  it('holds payment processors and overly specific marketplace guesses for review', async () => {
    completeJson.mockResolvedValueOnce({
      data: { category_slug: 'shopping', confidence: 0.99, merchant_type: 'payment_processor' }
    });
    expect(
      await classifyForwardedPurchase('PSE', categories, 'key', 'model', 'owner', usage as never)
    ).toBeNull();
    completeJson.mockResolvedValueOnce({
      data: { category_slug: 'clothing', confidence: 0.99, merchant_type: 'marketplace' }
    });
    expect(
      await classifyForwardedPurchase(
        'AMAZON.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toBeNull();
  });

  it('uses a known Colombian supermarket only when the owner has the matching active category', async () => {
    completeJson.mockClear();
    const groceries = {
      id: 'groceries-id',
      slug: 'groceries',
      name: 'Groceries',
      type: 'expense',
      is_active: true
    } as Category;
    expect(
      await classifyForwardedPurchase(
        'TIENDAS ARA',
        [...categories, groceries],
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toEqual({ categoryId: 'groceries-id', model: 'merchant-catalog-v1' });
    expect(completeJson).not.toHaveBeenCalled();
  });

  it('does not guess from a partial merchant name or inactive category', async () => {
    completeJson.mockResolvedValue({
      data: { category_slug: 'unknown', confidence: 0.5, merchant_type: 'unknown' }
    });
    const inactive = {
      id: 'groceries-id',
      slug: 'groceries',
      name: 'Groceries',
      type: 'expense',
      is_active: false
    } as Category;
    expect(
      await classifyForwardedPurchase(
        'ARA',
        [...categories, inactive],
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toBeNull();
  });

  it.each([
    { category_slug: 'missing', confidence: 0.99, merchant_type: 'specialist' },
    { category_slug: 'uncategorized', confidence: 0.99, merchant_type: 'specialist' },
    { category_slug: 'others', confidence: 0.99, merchant_type: 'specialist' },
    { category_slug: 'wages', confidence: 0.99, merchant_type: 'specialist' },
    { category_slug: 'unknown', confidence: 0.99, merchant_type: 'specialist' },
    { category_slug: 'clothing', confidence: 0.8, merchant_type: 'specialist' },
    { category_slug: 'clothing', confidence: 0.94, merchant_type: 'specialist' },
    { category_slug: 'clothing', confidence: 0.99, merchant_type: 'unknown' },
    { category_slug: 'clothing', confidence: 0.99 }
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

  it('rethrows provider failures only for bounded queue retries', async () => {
    completeJson.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      classifyForwardedPurchase(
        'SHEIN.COM',
        categories,
        'key',
        'model',
        'owner',
        usage as never,
        true
      )
    ).rejects.toThrow('Provider unavailable');
  });
});
