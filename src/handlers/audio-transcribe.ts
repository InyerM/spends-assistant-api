import { createSupabaseServices } from '../services/supabase';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import { aiConsentErrorResponse } from '../utils/ai-consent-response';
import { AUDIO_MODEL, transcribeAudio } from '../ai/audio-transcription';
import type { Env } from '../types/env';
export async function handleAudioTranscribe(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();
  try {
    const raw = await request.text();
    if (raw.length > 2800000) return Response.json({ error: 'Audio too large' }, { status: 413 });
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== 'object')
      return Response.json({ error: 'Invalid audio' }, { status: 400 });
    const { data, format, language, session_id, sequence, final } = body as Record<string, unknown>;
    if (
      typeof data !== 'string' ||
      data.length < 8 ||
      data.length > 2700000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(data) ||
      typeof format !== 'string' ||
      !['wav', 'webm', 'm4a', 'ogg', 'mp3'].includes(format) ||
      typeof language !== 'string' ||
      !['en', 'es', 'pt'].includes(language)
    )
      return Response.json({ error: 'Invalid audio' }, { status: 400 });
    const hasSession = session_id !== undefined || sequence !== undefined || final !== undefined;
    if (
      hasSession &&
      (typeof session_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(session_id) ||
        !Number.isInteger(sequence) ||
        Number(sequence) < 0 ||
        Number(sequence) > 3 ||
        typeof final !== 'boolean' ||
        (sequence === 3 && !final))
    )
      return Response.json({ error: 'Invalid audio session' }, { status: 400 });
    await services.aiConsent.require(userId, 'financial_text');
    const quota = hasSession
      ? await services.usage.reserveAudioTranscription(
          userId,
          session_id as string,
          sequence as number,
          final as boolean
        )
      : await services.usage.incrementAiParses(userId);
    if (!quota.allowed)
      return Response.json({ code: 'PARSE_LIMIT_REACHED', ...quota }, { status: 429 });
    const result = await services.aiUsage.track(
      { userId, operation: 'parse_expense', model: AUDIO_MODEL },
      (meter) => transcribeAudio({ data, format, language, apiKey: env.OPENROUTER_API_KEY, meter })
    );
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const consent = aiConsentErrorResponse(error);
    if (consent) return consent;
    return Response.json(
      { error: 'Audio transcription unavailable' },
      { status: error instanceof SyntaxError ? 400 : 502 }
    );
  }
}
