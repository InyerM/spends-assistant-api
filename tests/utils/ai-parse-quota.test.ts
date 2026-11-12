import { describe, expect, it, vi } from 'vitest';
import {
  reserveAiParse,
  aiParseQuotaErrorResponse,
  AiParseQuotaExceededError,
  AiParseQuotaUnavailableError
} from '../../src/utils/ai-parse-quota';

describe('AI parse quota boundary', () => {
  it('reserves once with the owner and denies exhausted allowance', async () => {
    const incrementAiParses = vi.fn().mockResolvedValue({ allowed: false, used: 15, limit: 15 });
    await expect(reserveAiParse({ incrementAiParses }, 'owner')).rejects.toBeInstanceOf(
      AiParseQuotaExceededError
    );
    expect(incrementAiParses).toHaveBeenCalledExactlyOnceWith('owner');
  });
  it('fails closed on reservation transport errors without exposing provider details', async () => {
    const incrementAiParses = vi.fn().mockRejectedValue(new Error('private transport details'));
    let failure: unknown;
    try {
      await reserveAiParse({ incrementAiParses }, 'owner');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AiParseQuotaUnavailableError);
    const response = aiParseQuotaErrorResponse(failure);
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain('private');
  });
  it('returns a bounded quota response and leaves unrelated errors alone', async () => {
    const response = aiParseQuotaErrorResponse(new AiParseQuotaExceededError(15, 15));
    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual({
      error: 'Parse limit reached',
      code: 'PARSE_LIMIT_REACHED',
      used: 15,
      limit: 15
    });
    expect(aiParseQuotaErrorResponse(new Error('unrelated'))).toBeNull();
  });
});
