import { expect, it, vi } from 'vitest';
import { CategoryReviewContextService } from '../src/services/supabase/category-review-context.service';
it('retrieves ordinary punctuated purpose words without admitting query syntax', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    await service.history(
      'owner',
      '',
      'expense',
      undefined,
      '«Colegio», libros. notes.ilike.*private*'
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams.get('or');
    expect(query).toContain('notes.ilike.*colegio*');
    expect(query).toContain('notes.ilike.*libros*');
    expect(query).not.toContain('private');
  } finally {
    vi.unstubAllGlobals();
  }
});
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

it('rejects a missing or foreign transaction before loading any history', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    await expect(
      service.reviewHistory('owner', 'Transfer DEMO X9', 'expense', 'foreign')
    ).rejects.toThrow('Review transaction not found');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('id')).toBe('eq.foreign');
    expect(url.searchParams.get('user_id')).toBe('eq.owner');
    expect(url.searchParams.get('deleted_at')).toBe('is.null');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('recovers bounded same-contact history independently of wording and merges lexical evidence', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json([{ id: 'current', user_id: 'owner' }]))
    .mockResolvedValueOnce(Response.json([{ contact_id: 'contact', user_id: 'owner' }]))
    .mockResolvedValueOnce(
      Response.json([
        {
          id: 'contact-old',
          description: 'School support',
          notes: 'Tuition',
          category: { name: 'Education' }
        },
        { id: 'shared', description: 'School books', notes: null, category: { name: 'Shopping' } }
      ])
    )
    .mockResolvedValueOnce(
      Response.json([
        {
          id: 'contact-old',
          description: 'School support',
          notes: 'Tuition',
          category: { name: 'Education' }
        },
        {
          id: 'lexical',
          description: 'Transfer X9 earlier',
          notes: null,
          category: { name: 'Other' }
        }
      ])
    );
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    const history = await service.reviewHistory('owner', 'Transfer DEMO X9', 'expense', 'current');
    expect(history.map((row) => row.id)).toEqual(['contact-old', 'shared', 'lexical']);
    expect(history[0].notes).toBe('Tuition');
    const link = new URL(String(fetcher.mock.calls[1][0]));
    expect(link.searchParams.get('user_id')).toBe('eq.owner');
    expect(link.searchParams.get('contact.user_id')).toBe('eq.owner');
    const contact = new URL(String(fetcher.mock.calls[2][0]));
    expect(contact.searchParams.get('user_id')).toBe('eq.owner');
    expect(contact.searchParams.get('contact_link.user_id')).toBe('eq.owner');
    expect(contact.searchParams.get('contact_link.contact_id')).toBe('eq.contact');
    expect(contact.searchParams.get('id')).toBe('neq.current');
    expect(contact.searchParams.get('category.or')).toBe('(user_id.eq.owner,user_id.is.null)');
    expect(contact.searchParams.get('type')).toBe('eq.expense');
    expect(contact.searchParams.get('deleted_at')).toBe('is.null');
    expect(contact.searchParams.get('order')).toBe('date.desc,id.desc');
    expect(contact.searchParams.get('limit')).toBe('8');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('falls back to lexical retrieval for an owned transaction without a contact', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json([{ id: 'current', user_id: 'owner' }]))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json([
        { id: 'lexical', description: 'DEMO purchase', notes: null, category: { name: 'Shopping' } }
      ])
    );
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    expect(
      (await service.reviewHistory('owner', 'DEMO', 'expense', 'current')).map((row) => row.id)
    ).toEqual(['lexical']);
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('caps merged evidence and excludes the current transaction defensively', async () => {
  const row = (id: string) => ({
    id,
    description: 'DEMO',
    notes: null,
    category: { name: 'Shopping' }
  });
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json([{ id: 'current', user_id: 'owner' }]))
    .mockResolvedValueOnce(Response.json([{ contact_id: 'contact', user_id: 'owner' }]))
    .mockResolvedValueOnce(
      Response.json([row('current'), ...Array.from({ length: 8 }, (_, i) => row(`contact-${i}`))])
    )
    .mockResolvedValueOnce(
      Response.json([row('current'), ...Array.from({ length: 12 }, (_, i) => row(`lexical-${i}`))])
    );
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    const history = await service.reviewHistory('owner', 'DEMO', 'expense', 'current');
    expect(history).toHaveLength(12);
    expect(history.some((row) => row.id === 'current')).toBe(false);
    expect(history.slice(0, 8).map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `contact-${i}`)
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it('finds notes-only evidence through bounded safe tokens in both historical fields', async () => {
  const fetcher = vi.fn().mockImplementation((input: string) => {
    const url = new URL(input);
    return Promise.resolve(
      Response.json(
        url.searchParams.get('or')?.includes('notes.ilike.*laptop*')
          ? [
              {
                id: 'notes-match',
                description: 'Equipment purchase',
                notes: 'Work laptop',
                category: { name: 'Work' }
              }
            ]
          : []
      )
    );
  });
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    expect(
      (
        await service.reviewHistory(
          'owner',
          'DEMO SHOP',
          'expense',
          undefined,
          'replacement laptop work'
        )
      ).map((row) => row.id)
    ).toEqual(['notes-match']);
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(params.get('or')).toContain('description.ilike.*laptop*');
    expect(params.get('category.user_id')).toBe('eq.owner');
    expect(params.get('category.is_active')).toBe('eq.true');
    expect(params.get('category.deleted_at')).toBe('is.null');
    expect(params.get('deleted_at')).toBe('is.null');
    expect(params.get('type')).toBe('eq.expense');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('reserves notes purpose tokens despite a long conflicting description and excludes syntax and boilerplate', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    await service.reviewHistory(
      'owner',
      'groceries market dinner food delivery shop',
      'expense',
      undefined,
      'the and para laptop tuition medical,or(user_id.eq.foreign) password abc123 secret@example.com'
    );
    const query = new URL(String(fetcher.mock.calls[0][0])).searchParams.get('or')!;
    expect(query).toContain('notes.ilike.*laptop*');
    expect(query).toContain('notes.ilike.*tuition*');
    expect(query).toContain('description.ilike.*groceries*');
    expect(query.match(/\.ilike\./g)?.length).toBeLessThanOrEqual(12);
    expect(query).not.toMatch(/foreign|password|example|abc|\*the\*|\*and\*|medical/);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('does not retrieve history from empty or boilerplate-only notes and descriptions', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    expect(
      await service.reviewHistory('owner', 'transfer payment', 'expense', undefined, '')
    ).toEqual([]);
    expect(
      await service.reviewHistory('owner', '', 'expense', undefined, 'the and para cuenta')
    ).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('loads exact history with owner, event cutoff and a bounded conflict window', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json([]));
  vi.stubGlobal('fetch', fetcher);
  try {
    const service = new CategoryReviewContextService('https://db.test', 'secret');
    await service.exactCategoryHistory('owner', 'SPOTIFY', 'expense', '2026-10-02');
    const params = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(params.get('user_id')).toBe('eq.owner');
    expect(params.get('description')).toBe('eq.SPOTIFY');
    expect(params.get('type')).toBe('eq.expense');
    expect(params.get('limit')).toBe('13');
    expect(params.get('and')).toContain('date.lte.2026-10-02');
    expect(params.get('deleted_at')).toBe('is.null');
  } finally {
    vi.unstubAllGlobals();
  }
});
it('uses explicit SQL identity then exact owner catalog linkage for bounded contact history', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: 'found', kind: 'account', value: '1234567890' }))
    .mockResolvedValueOnce(
      Response.json([
        { id: 'contact', user_id: 'owner', identity_kind: 'account', identity_value: '1234567890' }
      ])
    )
    .mockResolvedValueOnce(
      Response.json([
        {
          id: 'old',
          user_id: 'owner',
          description: 'Tuition',
          notes: 'Course',
          type: 'expense',
          date: '2026-10-01',
          category_id: 'category',
          contact_link: { user_id: 'owner', contact_id: 'contact' }
        }
      ])
    );
  vi.stubGlobal('fetch', fetcher);
  try {
    const result = await new CategoryReviewContextService(
      'https://db.test',
      'secret'
    ).verifiedContactHistory('owner', 'Transfer to 1234567890', 'expense', '2026-10-02');
    expect(result).toMatchObject({
      contactId: 'contact',
      rows: [{ id: 'old', contact_id: 'contact', description: 'Tuition' }]
    });
    expect(String(fetcher.mock.calls[0][0])).toContain('/rpc/counterparty_evidence');
    const catalog = new URL(String(fetcher.mock.calls[1][0])).searchParams;
    expect(catalog.get('user_id')).toBe('eq.owner');
    expect(catalog.get('identity_value')).toBe('eq.1234567890');
    expect(catalog.get('limit')).toBe('2');
    const history = new URL(String(fetcher.mock.calls[2][0])).searchParams;
    expect(history.get('contact_link.contact_id')).toBe('eq.contact');
    expect(history.get('user_id')).toBe('eq.owner');
    expect(history.get('limit')).toBe('13');
    expect(history.get('and')).toContain('date.lte.2026-10-02');
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([{ status: 'ambiguous' }, { status: 'no_evidence' }])(
  'does not identify a contact from missing or ambiguous explicit evidence ($status)',
  async (evidence) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(evidence));
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await new CategoryReviewContextService(
        'https://db.test',
        'secret'
      ).verifiedContactHistory('owner', 'A contact name only', 'expense', '2026-10-02');
      expect(result?.rows ?? []).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  }
);
it('rejects foreign or conflicting catalog identities before reading linked transactions', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: 'found', kind: 'account', value: '1234567890' }))
    .mockResolvedValueOnce(
      Response.json([
        { id: 'foreign', user_id: 'other', identity_kind: 'account', identity_value: '1234567890' }
      ])
    );
  vi.stubGlobal('fetch', fetcher);
  try {
    expect(
      await new CategoryReviewContextService('https://db.test', 'secret').verifiedContactHistory(
        'owner',
        'Transfer to 1234567890',
        'expense',
        '2026-10-02'
      )
    ).toMatchObject({ ambiguous: true, rows: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
