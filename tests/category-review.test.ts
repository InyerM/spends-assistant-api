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
it('uses localized category names in the explanation context and prior-history labels', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: 'food',
      description: 'Almuerzo',
      notes: '',
      explanation: 'Corresponde a Restaurantes.',
      kind: 'expense',
      evidence_ids: []
    }
  } as never);
  await reviewCategory(
    {
      locale: 'es',
      type: 'expense',
      description: 'Lunch',
      history: [{ id: 'old', description: 'Lunch', category: 'Restaurants' }]
    },
    [
      {
        ...categories[0],
        translations: { en: 'Restaurants', es: 'Restaurantes', pt: 'Restaurantes' }
      }
    ] as never,
    'key',
    'model'
  );
  const body = JSON.parse(vi.mocked(completeJson).mock.calls[0][0].user) as {
    categories: Array<{ name: string }>;
    history: Array<{ category: string }>;
  };
  expect(body.categories[0].name).toBe('Restaurantes');
  expect(body.history[0].category).toBe('Restaurantes');
});
it('offers Shopping for an unspecified marketplace purchase and never invents an item', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: null,
      description: 'Mercado Libre',
      notes: '',
      explanation: 'Unknown item',
      kind: 'expense',
      evidence_ids: []
    }
  } as never);
  const result = await reviewCategory(
    { locale: 'es', type: 'expense', description: 'Mercado Libre — item unverified', history: [] },
    [
      {
        id: 'shopping',
        slug: 'shopping',
        name: 'Shopping',
        translations: { es: 'Compras' },
        type: 'expense',
        is_active: true
      }
    ] as never,
    'key',
    'model'
  );
  expect(result.category_id).toBe('shopping');
  expect(result.explanation).toContain('Compras');
  const prompt = vi.mocked(completeJson).mock.calls[0][0].system;
  expect(prompt).toContain('automation');
  expect(prompt).toContain('technical');
});
it('honors a matching owned category rule even when the model abstains about purpose', async () => {
  vi.mocked(completeJson).mockResolvedValue({
    data: {
      category_id: null,
      description: 'Purchase',
      notes: '',
      explanation: 'Unknown',
      kind: 'unknown',
      evidence_ids: []
    }
  } as never);
  const result = await reviewCategory(
    { locale: 'es', type: 'expense', description: 'My purchase', history: [] },
    categories as never,
    'key',
    'model',
    undefined,
    { preferences: [], categoryRule: { category_id: 'food', name: 'Lunch rule' } }
  );
  expect(result.category_id).toBe('food');
  expect(result.kind).toBe('expense');
  expect(result.explanation).toContain('Lunch rule');
});
