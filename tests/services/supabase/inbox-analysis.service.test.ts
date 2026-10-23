import { beforeEach, expect, it, vi } from 'vitest';
import { createMockFetch } from '../../__test-helpers__/factories';
import { InboxAnalysisService } from '../../../src/services/supabase/inbox-analysis.service';

beforeEach(() => vi.restoreAllMocks());

it('scopes reads to the supplied owner and never includes raw text in a queue payload', async () => {
  const mock = createMockFetch({
    '/shortcut_inbox_items?': { data: [{ id: 'item', user_id: 'owner' }] }
  });
  vi.stubGlobal('fetch', mock);
  const service = new InboxAnalysisService('https://example.test', 'example');
  await service.item('owner', 'item');
  const url = new URL(String(mock.mock.calls[0][0]));
  expect(url.searchParams.get('user_id')).toBe('eq.owner');
  expect(url.searchParams.get('id')).toBe('eq.item');
});

it('uses audited claim and completion RPCs with the exact lease and owner', async () => {
  const mock = createMockFetch({
    '/rpc/claim_inbox_analysis_jobs': {
      data: [{ inbox_item_id: 'item', user_id: 'owner', lease_token: 'lease' }]
    },
    '/rpc/complete_inbox_analysis_job': { data: true },
    '/rpc/fail_inbox_analysis_job': { data: true }
  });
  vi.stubGlobal('fetch', mock);
  const service = new InboxAnalysisService('https://example.test', 'example');
  const [lease] = await service.claim(1, 'item', 'owner');
  await service.fail(lease, 'provider_unavailable', false);
  expect(JSON.parse(String(mock.mock.calls[1][1]?.body))).toEqual({
    p_inbox_item_id: 'item',
    p_user_id: 'owner',
    p_lease_token: 'lease',
    p_reason: 'provider_unavailable',
    p_retry_seconds: 60,
    p_blocked: false
  });
});

it('rejects malformed claim responses instead of processing unowned jobs', async () => {
  vi.stubGlobal(
    'fetch',
    createMockFetch({ '/rpc/claim_inbox_analysis_jobs': { data: [{ inbox_item_id: 'item' }] } })
  );
  const service = new InboxAnalysisService('https://example.test', 'example');
  await expect(service.claim(1)).rejects.toThrow('Invalid inbox analysis lease');
});

it('includes expired final leases for recovery without requeuing exhausted failures', async () => {
  const mock = createMockFetch({ '/inbox_analysis_jobs?': { data: [] } });
  vi.stubGlobal('fetch', mock);
  await new InboxAnalysisService('https://example.test', 'example').due();
  const url = new URL(String(mock.mock.calls[0][0]));
  expect(url.searchParams.has('attempts')).toBe(false);
  expect(url.searchParams.get('or')).toContain('and(state.in.(pending,failed),attempts.lt.3,');
  expect(url.searchParams.get('or')).toContain('and(state.eq.running,leased_until.lte.');
});
