import { describe, expect, it, vi } from 'vitest';
import { suggestForwardedEmail } from '../../src/ai/forwarded-email-suggestion';
import type { Category } from '../../src/types/category';

const { completeJson } = vi.hoisted(() => ({ completeJson: vi.fn() }));
vi.mock('../../src/ai/openrouter', () => ({ completeJson }));

const categories = [
  {
    id: 'education-id',
    user_id: 'owner',
    name: 'Education',
    slug: 'education',
    type: 'expense',
    is_active: true
  },
  {
    id: 'salary-id',
    user_id: 'owner',
    name: 'Salary',
    slug: 'salary',
    type: 'income',
    is_active: true
  }
] as Category[];
const usage = { track: vi.fn(async (_params, task) => task({ record: vi.fn() })) };

describe('forwarded email suggestions', () => {
  it('returns an owned category and bounded readable copy from a consent-gated model call', async () => {
    completeJson.mockResolvedValueOnce({
      data: {
        type: 'expense',
        category_slug: 'education',
        confidence: 0.94,
        description: 'Curso en CEA Practicar del Eje',
        notes: 'Compra con tarjeta terminada en 8456; verificar en el extracto.'
      }
    });
    expect(
      await suggestForwardedEmail(
        'Realizaste una compra en CEA PRACTICAR DEL EJE por $1,550,000',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toEqual({
      type: 'expense',
      categoryId: 'education-id',
      categorySource: 'catalog',
      description: 'Curso en CEA Practicar del Eje',
      notes: 'Compra con tarjeta terminada en 8456; verificar en el extracto.'
    });
    expect(usage.track).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'triage_forwarded_email' }),
      expect.any(Function),
      'forwarded_email'
    );
  });

  it('does not select a foreign or low-confidence category', async () => {
    completeJson.mockResolvedValueOnce({
      data: {
        type: 'expense',
        category_slug: 'education',
        confidence: 0.4,
        description: 'Compra por revisar',
        notes: 'Importe informado en el correo.'
      }
    });
    const suggestion = await suggestForwardedEmail(
      'Compra por revisar',
      categories,
      'key',
      'model',
      'owner',
      usage as never
    );
    expect(suggestion.categoryId).toBeNull();
  });

  it('keeps the known driving-school category when the model is uncertain', async () => {
    completeJson.mockResolvedValueOnce({
      data: {
        type: 'expense',
        category_slug: null,
        confidence: 0.2,
        description: 'Compra en CEA Practicar del Eje',
        notes: null
      }
    });
    expect(
      await suggestForwardedEmail(
        'Realizaste una compra en CEA PRACTICAR DEL EJE por $1,550,000',
        categories,
        'key',
        'model',
        'owner',
        usage as never
      )
    ).toMatchObject({ categoryId: 'education-id', categorySource: 'catalog' });
  });
});
