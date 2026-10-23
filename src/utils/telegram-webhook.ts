import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../types/env';

const MAX_BODY_BYTES = 65_536;
const MAX_TELEGRAM_ID = 4_503_599_627_370_495n;

export interface TelegramWebhookConfig {
  secret: string;
  chatId: string;
  senderId: string;
  ownerId: string;
  botToken: string;
}

function canonicalId(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  return BigInt(value) <= MAX_TELEGRAM_ID ? value : null;
}

export function telegramWebhookConfig(env: Env): TelegramWebhookConfig | null {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const chatId =
    typeof env.TELEGRAM_OWNER_CHAT_ID === 'string' ? canonicalId(env.TELEGRAM_OWNER_CHAT_ID) : null;
  const senderId =
    typeof env.TELEGRAM_OWNER_USER_ID === 'string' ? canonicalId(env.TELEGRAM_OWNER_USER_ID) : null;
  if (
    typeof secret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    !chatId ||
    !senderId ||
    typeof env.DEFAULT_USER_ID !== 'string' ||
    !env.DEFAULT_USER_ID ||
    env.DEFAULT_USER_ID.trim() !== env.DEFAULT_USER_ID ||
    typeof env.TELEGRAM_BOT_TOKEN !== 'string' ||
    !/^[A-Za-z0-9_:-]{1,256}$/.test(env.TELEGRAM_BOT_TOKEN)
  )
    return null;
  return {
    secret,
    chatId,
    senderId,
    ownerId: env.DEFAULT_USER_ID,
    botToken: env.TELEGRAM_BOT_TOKEN
  };
}

export function telegramSecretMatches(provided: string | null, expected: string): boolean {
  if (provided === null || !/^[A-Za-z0-9_-]{1,256}$/.test(provided)) return false;
  // Fixed-size ASCII buffers avoid secret-dependent comparisons, including length differences.
  const left = new Uint8Array(256);
  const right = new Uint8Array(256);
  left.set(new TextEncoder().encode(provided));
  right.set(new TextEncoder().encode(expected));
  return timingSafeEqual(left, right);
}

export function telegramCanonicalWebhookUrl(env: Env): string | null {
  const configured = env.TELEGRAM_WEBHOOK_URL;
  if (typeof configured !== 'string' || configured.length > 2048) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' &&
      url.pathname === '/telegram' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.href === configured
      ? configured
      : null;
  } catch {
    return null;
  }
}

export function telegramError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

type BoundedJson = { value: unknown; response?: never } | { value?: never; response: Response };

export async function readTelegramJson(request: Request): Promise<BoundedJson> {
  if (
    request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  )
    return { response: telegramError(415, 'JSON content is required') };
  const length = request.headers.get('Content-Length');
  if (
    length !== null &&
    (!/^(0|[1-9][0-9]{0,5})$/.test(length) || BigInt(length) > BigInt(MAX_BODY_BYTES))
  )
    return { response: telegramError(413, 'Update is too large') };
  const reader = request.body?.getReader();
  if (!reader) return { response: telegramError(400, 'Invalid update') };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { response: telegramError(413, 'Update is too large') };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      ) as unknown
    };
  } catch {
    return { response: telegramError(400, 'Invalid update') };
  } finally {
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateTelegramOwnerMessage(
  value: unknown,
  config: TelegramWebhookConfig
): Response | null {
  if (
    !record(value) ||
    Object.keys(value).some((key) => key !== 'update_id' && key !== 'message') ||
    !Number.isSafeInteger(value.update_id) ||
    (value.update_id as number) < 0
  )
    return telegramError(400, 'Unsupported update');
  const message = value.message;
  if (
    !record(message) ||
    !record(message.chat) ||
    !record(message.from) ||
    message.chat.type !== 'private' ||
    message.from.is_bot !== false ||
    canonicalId(message.chat.id) !== config.chatId ||
    canonicalId(message.from.id) !== config.senderId ||
    message.sender_chat !== undefined
  )
    return telegramError(403, 'Forbidden');
  if (
    !Number.isSafeInteger(message.message_id) ||
    (message.message_id as number) <= 0 ||
    !Number.isSafeInteger(message.date) ||
    (message.date as number) < 0 ||
    typeof message.text !== 'string' ||
    !message.text.trim() ||
    Array.from(message.text).length > 4096
  )
    return telegramError(400, 'Unsupported message');
  return null;
}
