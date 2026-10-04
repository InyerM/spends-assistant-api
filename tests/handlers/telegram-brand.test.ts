import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../__test-helpers__/factories';
import { handleTelegram } from '../../src/handlers/telegram';
import { parseExpense } from '../../src/parsers/expense';

const { reply } = vi.hoisted(() => ({ reply: vi.fn() }));

vi.mock('telegraf', () => ({
  Telegraf: class {
    private commands = new Map<string, (context: { reply: typeof reply }) => Promise<void>>();

    catch(): void {}
    on(): void {}

    command(
      names: string | string[],
      callback: (context: { reply: typeof reply }) => Promise<void>
    ): void {
      for (const name of Array.isArray(names) ? names : [names]) {
        this.commands.set(name, callback);
      }
    }

    async handleUpdate(update: { message: { text: string } }): Promise<void> {
      await this.commands.get(update.message.text.slice(1))?.({ reply });
    }
  }
}));
vi.mock('../../src/services/cache.service', () => ({ CacheService: class {} }));
vi.mock('../../src/parsers/expense', () => ({ parseExpense: vi.fn() }));

describe('Telegram customer-facing brand', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['start', 'Welcome to Anotto!', '/gasto 20k almuerzo'],
    ['help', 'Anotto Help', '/expense 50k uber']
  ])(
    'uses Anotto in /%s without parsing or posting a transaction',
    async (command, title, example) => {
      const response = await handleTelegram(
        new Request('https://worker.test/telegram', {
          method: 'POST',
          body: JSON.stringify({ message: { text: `/${command}` } })
        }),
        createMockEnv()
      );

      expect(response.status).toBe(200);
      expect(reply).toHaveBeenCalledOnce();
      const message = reply.mock.calls[0][0] as string;
      expect(message).toContain(title);
      expect(message).toContain(example);
      expect(message).not.toMatch(/Expense Assistant|Spends Assistant/);
      expect(parseExpense).not.toHaveBeenCalled();
    }
  );
});
