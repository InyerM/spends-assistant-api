import { ParsedExpense, GeminiResponse } from '../types/expense';
import { CacheService } from '../services/cache.service';
import { systemPrompt } from '../constants/parse-expens-system-prompt';

export async function parseExpense(
  text: string,
  apiKey: string,
  cache?: CacheService
): Promise<ParsedExpense> {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemPrompt },
          { text: `Input to parse: "${text}"` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  };

  console.log('[Gemini] Processing:', text.substring(0, 50) + '...');

  if (cache) {
    const cacheKey = `gemini:${cache.hashKey(text)}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      console.log('[Gemini] Cache hit');
      return JSON.parse(cached) as ParsedExpense;
    }
    console.log('[Gemini] Cache miss');
  }

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        console.warn(`[Gemini] Rate limit exceeded (429). Attempt ${attempts}/${maxAttempts}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        } else {
          throw new Error("Rate limit exceeded after multiple retries");
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as GeminiResponse;
      console.log('[Gemini] Full Response:', JSON.stringify(data, null, 2));

      const content = data.candidates[0].content.parts[0].text;
      const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
      const expense = JSON.parse(cleanContent) as ParsedExpense;

      console.log('[Gemini] Response:', JSON.stringify(expense));

      if (!expense.amount || expense.amount <= 0) {
        throw new Error("Invalid amount");
      }
      if (!expense.description || !expense.description.trim()) {
        throw new Error("Missing description");
      }
      if (!expense.category) {
        throw new Error("Missing category");
      }

      if (cache) {
        const cacheKey = `gemini:${cache.hashKey(text)}`;
        await cache.set(cacheKey, JSON.stringify(expense), 86400);
      }

      return expense;

    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error("Request timed out after 30 seconds");
      }
      if (attempts === maxAttempts || (error instanceof Error && !error.message.includes("Rate limit"))) {
        console.error("[Gemini] Error parsing:", error);
        throw error;
      }
    }
  }
  throw new Error("Failed to parse expense after multiple attempts");
}
