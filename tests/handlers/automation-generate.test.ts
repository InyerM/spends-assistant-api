import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAutomationGenerate } from '../../src/handlers/automation-generate';
import { createMockEnv } from '../__test-helpers__/factories';

describe('automation rule generation via OpenRouter', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns generated rules with privacy restricted provider routing', async () => {
    const env = createMockEnv();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('openrouter.ai')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rules: [
                      {
                        name: 'Restaurant',
                        conditions: { description_contains: 'cafe' },
                        actions: {},
                        rule_type: 'general'
                      }
                    ]
                  })
                },
                finish_reason: 'stop'
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost/automation/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Categorize cafe purchases' })
    });
    const response = await handleAutomationGenerate(request, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].name).toBe('Restaurant');
    const openRouterCall = fetchMock.mock.calls.find(([url]) => url.includes('openrouter.ai'));
    expect(openRouterCall).toBeDefined();
  });
});
