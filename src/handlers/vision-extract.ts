import { extractImageObservations } from '../ai/vision';
import { createSupabaseServices } from '../services/supabase';
import type { Env } from '../types/env';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';

const MAX_IMAGE_DATA_URL_LENGTH = 8_000_000;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Returns an extraction draft only; document and transaction writes belong to the review flow. */
export async function handleVisionExtract(request: Request, env: Env): Promise<Response> {
  const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const userId = await resolveUserId(request, env, services.apiKeys);
  if (!userId) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const imageDataUrl =
    body && typeof body === 'object' && 'image_data_url' in body
      ? (body as { image_data_url: unknown }).image_data_url
      : null;
  if (
    typeof imageDataUrl !== 'string' ||
    imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH ||
    !IMAGE_DATA_URL.test(imageDataUrl)
  ) {
    return json({ error: 'Invalid image data' }, 400);
  }

  try {
    const result = await extractImageObservations({
      apiKey: env.OPENROUTER_API_KEY,
      imageDataUrl,
      escalate: false
    });
    return json(result, 200);
  } catch {
    // The upstream response can contain the private image; do not echo or log it.
    return json({ error: 'Vision extraction failed' }, 502);
  }
}
