import { expect, it, vi } from 'vitest';
import { ShortcutInboxService } from '../../../src/services/supabase/shortcut-inbox.service';
it('looks up only the owner pending forwarding fingerprint after activation', async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json([{ id: 'inbox' }]));
  vi.stubGlobal('fetch', fetchMock);
  const service = new ShortcutInboxService('https://db.example', 'service-secret');
  expect(
    await service.getPendingForwarded('owner', 'a'.repeat(64), '2026-10-05T18:00:00Z')
  ).toEqual({ id: 'inbox' });
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get('user_id')).toBe('eq.owner');
  expect(url.searchParams.get('status')).toBe('eq.pending');
  expect(url.searchParams.get('source')).toBe('eq.forwarded_email');
  expect(url.searchParams.get('external_id')).toBe(`eq.${'a'.repeat(64)}`);
  expect(url.searchParams.get('received_at')).toBe('gte.2026-10-05T18:00:00Z');
});
