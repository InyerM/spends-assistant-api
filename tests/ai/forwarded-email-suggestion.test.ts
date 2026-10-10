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
      notes: 'Compra con tarjeta terminada en 8456; verificar en el extracto.',
      bankEventAt: null,
      amount: '1550000.00',
      eventDate: null,
      sourceLastFour: null
    });
    expect(usage.track).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'triage_forwarded_email' }),
      expect.any(Function),
      'forwarded_email'
    );
    expect(completeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoverMalformedOutput: true })
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
  it('recovers explicit event time from an unfamiliar bank notice independently of category confidence', async () => {
    const evidence = 'Pago QR de $15,800 completado el 02/10/2026 a las 4:31 p.m.';
    completeJson.mockResolvedValueOnce({
      data: {
        type: 'expense',
        confidence: 0.2,
        category_slug: null,
        event_date: '2026-10-02',
        event_time: '16:31',
        event_time_evidence: evidence
      }
    });
    const result = await suggestForwardedEmail(
      evidence,
      categories,
      'key',
      'model',
      'owner',
      usage as never
    );
    expect(result).toMatchObject({ bankEventAt: '2026-10-02T16:31:00-05:00', categoryId: null });
    expect(completeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ system: expect.stringContaining('event_time_evidence') })
    );
  });

  it.each([
    [
      'invented quotation',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31.',
      'Pago QR de $15,800 el 02/10/2026 a las 18:00.',
      '2026-10-02',
      '18:00'
    ],
    [
      'wrong time',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31.',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31.',
      '2026-10-02',
      '18:00'
    ],
    [
      'wrong date',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31.',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31.',
      '2026-10-03',
      '16:31'
    ],
    [
      'invalid date',
      'Pago QR de $15,800 el 30/02/2026 a las 16:31.',
      'Pago QR de $15,800 el 30/02/2026 a las 16:31.',
      '2026-02-30',
      '16:31'
    ],
    [
      'email header',
      'Date: 02/10/2026 16:31. Compra pendiente.',
      'Date: 02/10/2026 16:31.',
      '2026-10-02',
      '16:31'
    ],
    [
      'footer time',
      'Compra pendiente. Horario de atención: 02/10/2026 16:31.',
      'Horario de atención: 02/10/2026 16:31.',
      '2026-10-02',
      '16:31'
    ],
    [
      'ambiguous clocks',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31 o 18:00.',
      'Pago QR de $15,800 el 02/10/2026 a las 16:31 o 18:00.',
      '2026-10-02',
      '16:31'
    ]
  ])('rejects unsupported event time: %s', async (_name, message, evidence, date, time) => {
    completeJson.mockResolvedValueOnce({
      data: { type: 'expense', event_date: date, event_time: time, event_time_evidence: evidence }
    });
    expect(
      (await suggestForwardedEmail(message, categories, 'key', 'model', 'owner', usage as never))
        .bankEventAt
    ).toBeNull();
  });
});
