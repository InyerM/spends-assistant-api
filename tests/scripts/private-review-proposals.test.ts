import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewProposals,
  loadConfirmedProfile,
  writePrivateReport,
  summaryLine
} from '../../scripts/private-review-proposals.mjs';

const category = (id, slug = 'food') => ({
  id,
  slug,
  type: 'expense',
  is_active: true,
  deleted_at: null
});
const row = (id, overrides = {}) => ({
  id,
  user_id: 'owner-1',
  date: '2026-01-01',
  amount: 12000,
  type: 'expense',
  account_id: 'account-1',
  category_id: null,
  description: 'Cafe North',
  notes: null,
  raw_text: null,
  source: 'manual',
  ...overrides
});

describe('private review proposals', () => {
  it('suggests a category only from three same-owner, same-account, same-type distinct-date precedents', () => {
    const rows = [
      row('target', { date: '2026-04-01' }),
      row('p1', { date: '2026-01-10', category_id: 'cat-food' }),
      row('p2', { date: '2026-02-10', category_id: 'cat-food' }),
      row('p3', { date: '2026-03-10', category_id: 'cat-food' })
    ];
    const report = buildReviewProposals(rows, [category('cat-food')]);
    expect(report.proposals).toMatchObject([
      {
        transaction_id: 'target',
        kind: 'category_suggestion',
        before: { category_id: null },
        after: { category_id: 'cat-food' },
        confidence: 'high'
      }
    ]);
    expect(report.proposals[0].evidence.peer_transaction_ids).toEqual(['p1', 'p2', 'p3']);
  });

  it('refuses category inference when equally specific peers disagree', () => {
    const rows = [
      row('target', { date: '2026-04-01' }),
      row('p1', { date: '2026-01-10', category_id: 'cat-food' }),
      row('p2', { date: '2026-02-10', category_id: 'cat-food' }),
      row('p3', { date: '2026-03-10', category_id: 'cat-other' })
    ];
    const report = buildReviewProposals(rows, [
      category('cat-food'),
      category('cat-other', 'other')
    ]);
    expect(report.proposals.filter((proposal) => proposal.kind === 'category_suggestion')).toEqual(
      []
    );
  });

  it('does not infer category from equal-value but distinct payments or generic descriptions', () => {
    const rows = [
      row('target', { date: '2026-04-01', description: 'Book store' }),
      row('p1', { description: 'Cafe North', date: '2026-01-10', category_id: 'cat-food' }),
      row('p2', { description: 'Cafe North', date: '2026-02-10', category_id: 'cat-food' }),
      row('p3', { description: 'Cafe North', date: '2026-03-10', category_id: 'cat-food' }),
      row('generic', { description: 'Pago' })
    ];
    const report = buildReviewProposals(rows, [category('cat-food')]);
    expect(report.proposals.some((proposal) => proposal.transaction_id === 'target')).toBe(false);
    expect(
      report.proposals.some(
        (proposal) =>
          proposal.transaction_id === 'generic' && proposal.kind === 'category_suggestion'
      )
    ).toBe(false);
    expect(report.proposals).toMatchObject([
      {
        transaction_id: 'generic',
        kind: 'description_review',
        after: null,
        reason: 'generic_description'
      }
    ]);
  });

  it('flags empty descriptions without inventing replacement text', () => {
    const report = buildReviewProposals([row('empty', { description: '  ' })], []);
    expect(report.proposals).toMatchObject([
      {
        transaction_id: 'empty',
        kind: 'description_review',
        before: { description: '  ' },
        after: null,
        reason: 'empty_description',
        confidence: 'manual_review'
      }
    ]);
  });

  it('flags three monthly Nequi payments with dates and intervals, without changing records', () => {
    const rows = ['2026-01-01', '2026-02-01', '2026-03-01'].map((date, index) =>
      row(`n${index}`, { date, description: 'Internet service', raw_text: 'Nequi payment' })
    );
    const report = buildReviewProposals(rows, []);
    const recurring = report.proposals.filter((proposal) => proposal.kind === 'recurrence_review');
    expect(recurring).toHaveLength(3);
    expect(recurring[0]).toMatchObject({
      after: null,
      confidence: 'moderate',
      evidence: {
        dates: ['2026-01-01', '2026-02-01', '2026-03-01'],
        interval_days: [31, 28]
      }
    });
    expect(report.counts.recurring_groups).toBe(1);
  });

  it('does not group same-value Nequi payments to different people or duplicate dates', () => {
    const rows = [
      row('a1', { date: '2026-01-01', description: 'Alice phone', raw_text: 'Nequi' }),
      row('a2', { date: '2026-02-01', description: 'Alice phone', raw_text: 'Nequi' }),
      row('b', { date: '2026-03-01', description: 'Bob phone', raw_text: 'Nequi' }),
      row('a-duplicate', { date: '2026-02-01', description: 'Alice phone', raw_text: 'Nequi' })
    ];
    expect(buildReviewProposals(rows, []).counts.recurring_groups).toBe(0);
  });
});

describe('private exporter boundaries', () => {
  const tempDirs = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('pages active rows, selects only the unique confirmed-count profile, and scopes detail reads', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, options) => {
      requests.push({ url: String(url), options });
      const parsed = new URL(url);
      const table = parsed.pathname.split('/').at(-1);
      const offset = Number(parsed.searchParams.get('offset'));
      let data;
      if (table === 'transactions' && parsed.searchParams.get('select') === 'user_id') {
        data =
          offset === 0
            ? [{ user_id: 'owner-1' }, { user_id: 'owner-1' }]
            : offset === 2
              ? [{ user_id: 'owner-1' }, { user_id: 'other' }]
              : [];
      } else if (table === 'transactions') {
        data = offset === 0 ? [row('1'), row('2')] : offset === 2 ? [row('3')] : [];
      } else data = [];
      return { ok: true, json: async () => data };
    });
    const result = await loadConfirmedProfile({
      url: 'https://test.supabase.co',
      key: 'secret',
      expectedCount: 3,
      pageSize: 2,
      fetchImpl
    });
    expect(result.rows).toHaveLength(3);
    expect(requests.every(({ options }) => options.method === 'GET')).toBe(true);
    expect(
      requests
        .filter(({ url }) => url.includes('select=id%2Cuser_id'))
        .every(({ url }) => url.includes('user_id=eq.owner-1'))
    ).toBe(true);
  });

  it('stops when the confirmed count could select more than one user', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [{ user_id: 'owner-1' }, { user_id: 'owner-2' }]
    }));
    await expect(
      loadConfirmedProfile({
        url: 'https://test.supabase.co',
        key: 'secret',
        expectedCount: 1,
        pageSize: 500,
        fetchImpl
      })
    ).rejects.toThrow('one profile');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('writes a mode-0600 report outside Git and prints only aggregate counts and path', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'review-test-'));
    tempDirs.push(outputRoot);
    const report = buildReviewProposals([row('private-id', { description: '' })], []);
    const path = await writePrivateReport(report, { outputRoot, repoRoot: process.cwd() });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toContain('private-id');
    const summary = summaryLine(report, path);
    expect(summary).toContain(path);
    expect(summary).not.toContain('private-id');
    expect(summary).not.toContain('owner-1');
  });

  it('refuses to write the private report inside the repository', async () => {
    const report = buildReviewProposals([row('private-id', { description: '' })], []);
    await expect(
      writePrivateReport(report, { outputRoot: process.cwd(), repoRoot: process.cwd() })
    ).rejects.toThrow('outside the repository');
  });
});
