import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleInboxAnalyze, handleInboxAnalysisDispatch } from '../../src/handlers/inbox-analysis';
import { createMockEnv } from '../__test-helpers__/factories';
import { AI_CONSENT_VERSION } from '../../src/services/supabase/ai-consent.service';

const id = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  item: vi.fn(),
  analysis: vi.fn(),
  job: vi.fn(),
  request: vi.fn(),
  claim: vi.fn(),
  process: vi.fn(),
  dispatch: vi.fn()
}));
vi.mock('../../src/utils/auth', () => ({
  resolveUserId: mocks.auth,
  unauthorizedResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 })
}));
vi.mock('../../src/services/supabase', () => ({
  createSupabaseServices: () => ({
    apiKeys: {},
    inboxAnalysis: {
      item: mocks.item,
      analysis: mocks.analysis,
      job: mocks.job,
      request: mocks.request,
      claim: mocks.claim
    }
  })
}));
vi.mock('../../src/services/inbox-analysis', () => ({
  processInboxAnalysisLease: mocks.process,
  dispatchInboxAnalysis: mocks.dispatch
}));
const item = () => ({
  id,
  user_id: owner,
  status: 'pending',
  source: 'sms-shortcut',
  raw_text: 'Private synthetic capture'
});
const analysis = () => ({
  inbox_item_id: id,
  user_id: owner,
  analysis_version: 3,
  category_id: 'owned-category',
  amount: 12,
  description: 'Coffee',
  analysis_details: {
    analysis_source: 'history',
    explanation: 'Reviewed purpose',
    event_date: '2026-10-22',
    financial_type: 'expense',
    transfer_to_account_id: null,
    automation_fields: [],
    history_fields: ['categoryId'],
    applied_rules: [],
    evidence_ids: ['owned-evidence'],
    amount: 999,
    account_id: 'foreign',
    lease_token: 'private',
    raw_text: 'do-not-return'
  }
});
function request(body: unknown, method = 'POST'): Request {
  return new Request('https://worker.test/inbox/analyze', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(owner);
  mocks.item.mockResolvedValue(item());
  mocks.analysis.mockResolvedValue(null);
  mocks.job.mockResolvedValue({ state: 'running', last_error: null });
  mocks.request.mockResolvedValue('pending');
  mocks.claim.mockResolvedValue([{ inbox_item_id: id, user_id: owner, lease_token: 'lease' }]);
  mocks.process.mockResolvedValue(undefined);
  mocks.dispatch.mockResolvedValue(undefined);
});
describe('owner-scoped inbox analysis handlers', () => {
  it('requires authentication without reading private capture data', async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv())).status).toBe(
      401
    );
    expect(mocks.item).not.toHaveBeenCalled();
  });
  it.each([
    { inbox_item_id: 'bad' },
    { inbox_item_id: id, refresh: 'yes' },
    { inbox_item_id: id, extra: true },
    null,
    []
  ])('rejects malformed strict analyze input %j', async (body) => {
    expect((await handleInboxAnalyze(request(body), createMockEnv())).status).toBe(400);
    expect(mocks.item).not.toHaveBeenCalled();
  });
  it('bounds actual bytes regardless of content length', async () => {
    const response = await handleInboxAnalyze(
      request({ inbox_item_id: id, padding: 'x'.repeat(5000) }),
      createMockEnv()
    );
    expect(response.status).toBe(413);
    expect(mocks.item).not.toHaveBeenCalled();
  });
  it('returns owned v3 cache and flattens only safe metadata without replacing authoritative fields', async () => {
    mocks.analysis.mockResolvedValue(analysis());
    const response = await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      amount: 12,
      category_id: 'owned-category',
      analysis_source: 'history',
      evidence_ids: ['owned-evidence']
    });
    expect(result).not.toHaveProperty('analysis_details');
    expect(result).not.toHaveProperty('lease_token');
    expect(result).not.toHaveProperty('raw_text');
    expect(result).not.toHaveProperty('account_id');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('returns an existing reviewed v3 cache even when refresh is requested', async () => {
    mocks.item.mockResolvedValue({ ...item(), status: 'created' });
    mocks.analysis.mockResolvedValue(analysis());
    expect(
      (await handleInboxAnalyze(request({ inbox_item_id: id, refresh: true }), createMockEnv()))
        .status
    ).toBe(200);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rejects a nonpending capture without current cache and hides foreign capture existence', async () => {
    mocks.item.mockResolvedValue({ ...item(), status: 'dismissed' });
    expect((await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv())).status).toBe(
      409
    );
    mocks.item.mockResolvedValue({ ...item(), user_id: 'foreign' });
    expect((await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv())).status).toBe(
      404
    );
  });
  it('processes a scoped lease then returns the newly persisted result', async () => {
    mocks.analysis.mockResolvedValueOnce(null).mockResolvedValueOnce(analysis());
    mocks.job.mockResolvedValue({ state: 'ready', last_error: null });
    expect(
      (await handleInboxAnalyze(request({ inbox_item_id: id, refresh: true }), createMockEnv()))
        .status
    ).toBe(200);
    expect(mocks.request).toHaveBeenCalledWith(owner, id, true);
    expect(mocks.claim).toHaveBeenCalledWith(1, id, owner);
    expect(mocks.process).toHaveBeenCalledWith(
      { inbox_item_id: id, user_id: owner, lease_token: 'lease' },
      expect.any(Object)
    );
  });
  it('returns 202 without duplicating a running worker', async () => {
    mocks.claim.mockResolvedValue([]);
    const response = await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ state: 'running' });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it.each([
    ['consent_required', 428],
    ['quota_limit', 429],
    ['unverified_source', 403],
    ['invalid_source', 422],
    ['provider_unavailable', 503]
  ])('maps persisted failure %s without private error details', async (reason, status) => {
    mocks.claim.mockResolvedValue([]);
    mocks.job.mockResolvedValue({ state: 'blocked', last_error: reason });
    const response = await handleInboxAnalyze(request({ inbox_item_id: id }), createMockEnv());
    expect(response.status).toBe(status);
    const result = await response.json();
    if (reason === 'consent_required')
      expect(result).toMatchObject({
        code: 'AI_CONSENT_REQUIRED',
        scope: 'financial_text',
        version: AI_CONSENT_VERSION
      });
    if (reason === 'quota_limit') expect(result.code).toBe('PARSE_LIMIT_REACHED');
    expect(JSON.stringify(result)).not.toContain('Private synthetic');
  });
  it('dispatches a bounded unique owned pending list with background work', async () => {
    const waitUntil = vi.fn();
    const response = await handleInboxAnalysisDispatch(
      request({ inbox_item_ids: [id, id] }),
      createMockEnv(),
      { waitUntil } as unknown as ExecutionContext
    );
    expect(response.status).toBe(202);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(owner, id, false);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.any(Object), owner, [id]);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
  it('rejects an unowned dispatch member before scheduling any owned member', async () => {
    mocks.item.mockImplementation(async (_owner: string, key: string) =>
      key === id ? item() : null
    );
    const waitUntil = vi.fn();
    expect(
      (
        await handleInboxAnalysisDispatch(
          request({ inbox_item_ids: [id, otherId] }),
          createMockEnv(),
          { waitUntil } as unknown as ExecutionContext
        )
      ).status
    ).toBe(404);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
  it.each([[], Array.from({ length: 26 }, () => id), ['invalid']])(
    'rejects an invalid dispatch list',
    async (ids) => {
      const waitUntil = vi.fn();
      expect(
        (
          await handleInboxAnalysisDispatch(request({ inbox_item_ids: ids }), createMockEnv(), {
            waitUntil
          } as unknown as ExecutionContext)
        ).status
      ).toBe(400);
      expect(waitUntil).not.toHaveBeenCalled();
    }
  );
  it('does not hide a refresh consent failure behind an older cached proposal', async () => {
    mocks.analysis.mockResolvedValue(analysis());
    mocks.item.mockResolvedValue({ ...item(), source: 'forwarded_email' });
    mocks.claim.mockResolvedValue([]);
    mocks.job.mockResolvedValue({ state: 'blocked', last_error: 'consent_required' });
    const response = await handleInboxAnalyze(
      request({ inbox_item_id: id, refresh: true }),
      createMockEnv()
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      scope: 'forwarded_email',
      code: 'AI_CONSENT_REQUIRED'
    });
  });
  it('does not schedule nonpending captures or unauthenticated dispatches', async () => {
    const waitUntil = vi.fn();
    mocks.item.mockResolvedValue({ ...item(), status: 'matched' });
    expect(
      (
        await handleInboxAnalysisDispatch(request({ inbox_item_ids: [id] }), createMockEnv(), {
          waitUntil
        } as unknown as ExecutionContext)
      ).status
    ).toBe(409);
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue(null);
    expect(
      (
        await handleInboxAnalysisDispatch(request({ inbox_item_ids: [id] }), createMockEnv(), {
          waitUntil
        } as unknown as ExecutionContext)
      ).status
    ).toBe(401);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
