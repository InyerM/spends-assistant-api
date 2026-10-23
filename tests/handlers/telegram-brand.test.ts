import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockEnv } from '../__test-helpers__/factories';
import { handleTelegram } from '../../src/handlers/telegram';
import { parseExpense } from '../../src/parsers/expense';
import { AiConsentRequiredError } from '../../src/services/supabase/ai-consent.service';

const { reply } = vi.hoisted(() => ({ reply: vi.fn() }));
const webhookSecret = 'unit-webhook-secret-with-at-least-32-characters';
const authorizedEnv = () => ({
  ...createMockEnv(),
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  TELEGRAM_OWNER_CHAT_ID: '12345',
  TELEGRAM_OWNER_USER_ID: '12345'
});
const ownerMessage = (text: string) =>
  new Request('https://worker.test/telegram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': webhookSecret
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text,
        chat: { id: 12345, type: 'private' },
        from: { id: 12345, is_bot: false, first_name: 'Test' }
      }
    })
  });

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
      const [command] = update.message.text.slice(1).split(' ');
      await this.commands.get(command)?.({
        reply,
        message: update.message,
        sendChatAction: vi.fn()
      } as never);
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
      const response = await handleTelegram(ownerMessage(`/${command}`), authorizedEnv());

      expect(response.status).toBe(200);
      expect(reply).toHaveBeenCalledOnce();
      const message = reply.mock.calls[0][0] as string;
      expect(message).toContain(title);
      expect(message).toContain(example);
      expect(message).not.toMatch(/Expense Assistant|Spends Assistant/);
      expect(parseExpense).not.toHaveBeenCalled();
    }
  );

  it('asks the user to enable consent without echoing a Telegram expense', async () => {
    vi.mocked(parseExpense).mockRejectedValue(new AiConsentRequiredError('financial_text'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([]))
    );
    await handleTelegram(ownerMessage('/gasto private purchase details'), authorizedEnv());
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('AI data sharing'));
    expect(JSON.stringify(reply.mock.calls)).not.toContain('private purchase details');
    vi.unstubAllGlobals();
  });
});
