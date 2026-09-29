import { describe, expect, it, vi } from 'vitest';
import {
  buildRequestBody,
  createLiveResponder,
  createOracleResponder
} from '../../../scripts/eval/text-models/client';
import { parseCliArgs, runCli, worstCaseCostUsd } from '../../../scripts/eval/text-models/cli';
import { FIXTURES, REFERENCE_DATE } from '../../../scripts/eval/text-models/fixtures';
import { MODELS } from '../../../scripts/eval/text-models/models';
import { renderReport } from '../../../scripts/eval/text-models/report';
import { runEvaluation } from '../../../scripts/eval/text-models/runner';
import type { Fixture } from '../../../scripts/eval/text-models/types';

const model = MODELS[0];
const fixture = FIXTURES[0];
const SECRET_TEXT = 'SECRET-MERCHANT-TEXT';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function completion(content: string | null, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3000, completion_tokens: 120, cost: 0.00045 },
    ...extra
  };
}

function clock(...ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

describe('buildRequestBody', () => {
  it('mirrors production privacy routing with a pinned clock and usage accounting', () => {
    const body = buildRequestBody(fixture, model) as {
      model: string;
      messages: Array<{ content: string }>;
      usage: unknown;
      provider: Record<string, unknown>;
    };
    expect(body.model).toBe(model.id);
    expect(body.messages[0].content).toContain(`CURRENT_DATE: ${REFERENCE_DATE}`);
    expect(body.messages[1].content).toBe(`Input to parse: ${fixture.text}`);
    expect(body.usage).toEqual({ include: true });
    expect(body.provider).toEqual({
      zdr: true,
      data_collection: 'deny',
      max_price: { prompt: 0.13, completion: 0.52 }
    });
  });
});

describe('createLiveResponder', () => {
  it('requires an API key', () => {
    expect(() => createLiveResponder({ apiKey: '' })).toThrow('OPENROUTER_API_KEY');
  });

  it('returns parsed data, latency, and reported cost', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(completion('{"is_transaction":false}')));
    const respond = createLiveResponder({ apiKey: 'k', fetchImpl, now: clock(1000, 1250) });
    const result = await respond(fixture, model);
    expect(result).toEqual({
      latencyMs: 250,
      usage: { promptTokens: 3000, completionTokens: 120, costUsd: 0.00045 },
      data: { is_transaction: false },
      error: null
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('keeps usage without cost when OpenRouter omits it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(completion('{}', { usage: { prompt_tokens: 1, completion_tokens: 2 } }))
      );
    const result = await createLiveResponder({ apiKey: 'k', fetchImpl })(fixture, model);
    expect(result.usage).toEqual({ promptTokens: 1, completionTokens: 2, costUsd: null });
    const noUsage = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    expect(
      (await createLiveResponder({ apiKey: 'k', fetchImpl: noUsage })(fixture, model)).usage
    ).toBeNull();
  });

  it.each([
    ['invalid JSON content', jsonResponse(completion('not json')), 'invalid_json'],
    ['a JSON array', jsonResponse(completion('[1]')), 'invalid_json'],
    ['empty content', jsonResponse(completion(null)), 'empty'],
    [
      'a truncated answer',
      jsonResponse({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }),
      'truncated'
    ],
    ['a non-JSON body', new Response('oops', { status: 200 }), 'invalid_json']
  ])('classifies %s', async (_name, response, error) => {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const result = await createLiveResponder({ apiKey: 'k', fetchImpl })(fixture, model);
    expect(result.error).toBe(error);
    expect(result.data).toBeNull();
  });

  it('drops upstream error bodies that could echo private text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: SECRET_TEXT }, 400));
    const result = await createLiveResponder({ apiKey: 'k', fetchImpl })(fixture, model);
    expect(result).toMatchObject({ error: 'http', status: 400, data: null });
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT);
  });

  it('classifies timeouts and network failures', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const timedOut = vi.fn().mockRejectedValue(timeout);
    expect(
      (await createLiveResponder({ apiKey: 'k', fetchImpl: timedOut })(fixture, model)).error
    ).toBe('timeout');
    const offline = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(
      (await createLiveResponder({ apiKey: 'k', fetchImpl: offline })(fixture, model)).error
    ).toBe('network');
  });
});

describe('runEvaluation and renderReport', () => {
  it('score the oracle perfectly and keep message text out of the report', async () => {
    const secretFixture: Fixture = { ...FIXTURES[7], text: SECRET_TEXT };
    const result = await runEvaluation({
      mode: 'offline',
      referenceDate: REFERENCE_DATE,
      fixtures: [...FIXTURES, secretFixture],
      models: MODELS.slice(0, 2),
      responder: createOracleResponder(),
      repeats: 2
    });
    expect(result.repeats).toBe(2);
    for (const s of result.summaries) {
      expect(s.runs).toBe((FIXTURES.length + 1) * 2);
      expect(s.fieldAccuracy).toBe(1);
      expect(s.failures).toEqual([]);
    }
    const report = renderReport(result, '2026-09-28T00:00:00.000Z');
    expect(report).toContain('| deepseek/deepseek-v4.1-flash |');
    expect(report).toContain('Verdict:');
    expect(report).not.toContain(SECRET_TEXT);
    for (const f of FIXTURES) expect(report).not.toContain(f.text);
  });

  it('list mismatches and observed cost in a live-style report', async () => {
    const result = await runEvaluation({
      mode: 'live',
      referenceDate: REFERENCE_DATE,
      fixtures: FIXTURES.slice(0, 2),
      models: [model],
      responder: async () => ({
        latencyMs: 10,
        usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.02 },
        data: { is_transaction: false, amount: SECRET_TEXT },
        error: null
      })
    });
    const report = renderReport(result, 'now');
    expect(report).toContain('- sms-debit-grocery: is_transaction, amount');
    expect(report).toContain('$0.040');
    expect(report).not.toContain(SECRET_TEXT);
    expect(report).not.toContain('oracle');
  });
});

describe('CLI', () => {
  it('parse defaults and flags', () => {
    expect(parseCliArgs([])).toEqual({
      live: false,
      models: undefined,
      includeOptional: false,
      repeats: 1,
      maxUsd: 0.5,
      write: true
    });
    expect(
      parseCliArgs(['--live', '--models', 'a, b', '--repeats', '3', '--max-usd', '2', '--no-write'])
    ).toMatchObject({ live: true, models: ['a', 'b'], repeats: 3, maxUsd: 2, write: false });
    expect(() => parseCliArgs(['--repeats', '0'])).toThrow('--repeats');
    expect(() => parseCliArgs(['--max-usd', '-1'])).toThrow('--max-usd');
    expect(() => parseCliArgs(['--unknown'])).toThrow();
  });

  it('compute a worst-case spend guard', () => {
    expect(worstCaseCostUsd([model], 10)).toBeCloseTo(0.0078);
  });

  function deps(env: Record<string, string | undefined> = {}) {
    const lines: string[] = [];
    const writes: Array<[string, string]> = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(completion('{"is_transaction":false}')));
    return {
      lines,
      writes,
      fetchImpl,
      value: {
        env,
        log: (line: string) => lines.push(line),
        fetchImpl,
        now: () => new Date('2026-09-28T12:00:00.000Z'),
        writeReport: async (name: string, contents: string) => {
          writes.push([name, contents]);
          return `results/${name}`;
        }
      }
    };
  }

  it('run the offline self-test by default without network calls', async () => {
    const d = deps({ OPENROUTER_API_KEY: 'k' });
    expect(await runCli([], d.value)).toBe(0);
    expect(d.fetchImpl).not.toHaveBeenCalled();
    expect(d.lines).toContain('Offline self-test passed.');
    expect(d.writes.map(([name]) => name)).toEqual([
      '2026-09-28T12-00-00-000Z-offline.md',
      '2026-09-28T12-00-00-000Z-offline.json'
    ]);
  });

  it('refuse live runs without a local key', async () => {
    const d = deps({ OPENROUTER_API_KEY: '  ' });
    expect(await runCli(['--live'], d.value)).toBe(2);
    expect(d.fetchImpl).not.toHaveBeenCalled();
    expect(d.lines.at(-1)).toContain('No requests were sent');
  });

  it('refuse live runs above the spending guard', async () => {
    const d = deps({ OPENROUTER_API_KEY: 'k' });
    expect(await runCli(['--live', '--include-optional', '--max-usd', '0.01'], d.value)).toBe(2);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  it('run live with the flag and a key, without leaking the key', async () => {
    const d = deps({ OPENROUTER_API_KEY: 'sk-or-test-secret' });
    expect(await runCli(['--live', '--models', model.id, '--no-write'], d.value)).toBe(0);
    expect(d.fetchImpl).toHaveBeenCalledTimes(FIXTURES.length);
    expect(d.writes).toEqual([]);
    expect(d.lines.join('\n')).not.toContain('sk-or-test-secret');
    expect(d.lines.join('\n')).toContain('Mode: **live**');
  });

  it('reject bad arguments and unsafe fixtures', async () => {
    expect(await runCli(['--models', 'nope/model'], deps().value)).toBe(2);
    const d = deps();
    const leaky: Fixture = { ...FIXTURES[0], text: 'mail a@b.co' };
    expect(await runCli([], { ...d.value, fixtures: [leaky] })).toBe(1);
    expect(d.lines).toContain(`- ${leaky.id}: contains email address`);
  });

  it('fail the offline self-test when scoring is broken', async () => {
    const d = deps();
    const impossible: Fixture = {
      ...FIXTURES[0],
      expected: { is_transaction: true, fields: { amount: 'not-a-number' } }
    };
    expect(await runCli(['--no-write'], { ...d.value, fixtures: [impossible] })).toBe(1);
    expect(d.lines.at(-1)).toContain('Offline self-test failed');
  });
});
