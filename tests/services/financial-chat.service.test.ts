import { describe, expect, it, vi } from 'vitest';
import { FinancialChatService } from '../../src/services/supabase/financial-chat.service';

describe('bounded owner-scoped financial snapshot', () => {
  it('limits each tool and excludes archived documents, deleted and duplicate transactions', async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const service = new FinancialChatService('https://database.example', 'service-key');
    await service.snapshot('owner-a', '2026-12');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) {
      const params = new URL(url).searchParams;
      expect(params.get('user_id')).toBe('eq.owner-a');
      expect(params.get('select')).not.toMatch(/raw_text|parsed_data|file_path|file_name/);
      expect(Number(params.get('limit'))).toBeLessThanOrEqual(101);
      if (url.includes('/transactions?')) {
        expect(params.get('and')).toBe('(date.gte.2026-12-01,date.lt.2027-01-01)');
        expect(params.get('deleted_at')).toBe('is.null');
        expect(params.get('duplicate_status')).toBe('is.null');
      }
      if (url.includes('/documents?')) expect(params.get('archived_at')).toBe('is.null');
    }
  });
});
