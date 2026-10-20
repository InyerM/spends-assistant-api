import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/ai/openrouter', () => ({ completeJson: vi.fn() }));
import { completeJson } from '../src/ai/openrouter';
import { reviewCategory } from '../src/ai/category-review';
const categories = [
  { id: 'food', name: 'Restaurants', slug: 'restaurant', type: 'expense', is_active: true }
];
beforeEach(() => vi.clearAllMocks());
it('returns a grounded explanation and rewrites without changing posting facts', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: 'food',
      description: 'Lunch',
      notes: 'Weekly meal',
      explanation: 'Two previous movements used Restaurants and mention lunch.',
      kind: 'expense',
      evidence_ids: ['old', 'foreign']
    }
  } as never);
  const result = await reviewCategory(
    {
      locale: 'es',
      type: 'expense',
      description: 'Transfer',
      notes: 'Lunch',
      history: [{ id: 'old', description: 'Lunch', notes: 'Meals', category: 'Restaurants' }]
    },
    categories as never,
    'key',
    'model'
  );
  expect(result.category_id).toBe('food');
  expect(result.evidence_ids).toEqual(['old']);
  expect(result.explanation).toContain('previous');
});
it('does not invent an income category for a credit card payment or accept foreign categories', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: 'foreign',
      description: 'Payment',
      notes: '',
      explanation: 'Payment origin is missing.',
      kind: 'own_transfer',
      evidence_ids: []
    }
  } as never);
  const result = await reviewCategory(
    {
      locale: 'es',
      type: 'income',
      account_type: 'credit_card',
      description: 'ABONO SUCURSAL VIRTUAL',
      history: []
    },
    categories as never,
    'key',
    'model'
  );
  expect(result.category_id).toBeNull();
  expect(result.kind).toBe('own_transfer');
});
it('reviews wording on an existing transfer without assigning an expense or income category', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: 'food',
      description: 'Payment between my accounts',
      notes: 'Reviewed note',
      explanation: 'Existing transfer keeps its financial meaning.',
      kind: 'expense',
      evidence_ids: []
    }
  } as never);
  const result = await reviewCategory(
    { locale: 'es', type: 'transfer', description: 'Bank transfer', history: [] } as never,
    categories as never,
    'key',
    'model'
  );
  expect(result.kind).toBe('own_transfer');
  expect(result.category_id).toBeNull();
});
