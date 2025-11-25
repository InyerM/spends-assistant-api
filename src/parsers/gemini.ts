import { ParsedExpense, GeminiResponse } from '../types/expense';
import { CacheService } from '../services/cache.service';

export async function parseExpense(
  text: string,
  apiKey: string,
  cache?: CacheService
): Promise<ParsedExpense> {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const systemPrompt = `
You are an expert Colombian financial assistant that extracts expense data.

POSSIBLE INPUTS:
1. Bancolombia email: "Bancolombia: Compraste $X en Y con tu T.Deb/Crédito *XXXX, el DD/MM/YYYY a las HH:MM"
2. Nequi SMS (number 85954): "Nequi: Pagaste $X en Y. Saldo: $Z"
3. Manual message: "20k in rappi", "50mil for lunch", "bought 100mil groceries" (in spanish or english)

OUTPUT (strict JSON without markdown):
{
  "amount": number,
  "description": string,
  "category": "food|transportation|entertainment|shopping|services|health|education|home|technology|subscriptions|utilities|other",
  "bank": "bancolombia|nequi|daviplata|cash|other",
  "payment_type": "debit|credit|cash|transfer|qr",
  "source": "bancolombia_email|nequi_sms|manual",
  "confidence": number (0-100),
  "original_date": string | null,
  "original_time": string | null,
  "last_four": string | null
}

INTELLIGENT CATEGORIZATION (Colombia):

Food:
- rappi, uber eats, domicilios, ifood, pedidos ya
- restaurants, lunch, breakfast, dinner, bakery
- cafe, juan valdez, starbucks, oma
- groceries, fruits, vegetables

Transportation:
- uber, didi, cabify, beat, indriver, taxi
- bus, metro, transmilenio, sitp
- gas, terpel, mobil, esso
- parking, toll

Entertainment:
- netflix, spotify, disney+, prime video, hbo max
- cinema, cinemark, cinepolis, procinal
- bars, clubs, beer
- videogames, codashop, steam, epic games, xbox, playstation

Shopping:
- exito, carrefour, jumbo, olimpica, makro, metro
- ara, d1, justo & bueno, stores
- supermarket, groceries
- clothes, shoes, falabella, éxito

Health:
- farmatodo, cruz verde, cafam, colsubsidio
- pharmacy, medicines
- doctor, dentist, laboratory
- gym, smartfit, bodytech, fitpal

Utilities:
- epm, codensa, eaab, gas natural
- claro, movistar, tigo, wom, virgin mobile
- internet, cable, tv
- water, electricity, gas, utilities

Education:
- courses, udemy, platzi, coursera
- books, bookstore, nacional, lerner
- university, school, tuition

Home:
- homecenter, sodimac, easy
- hardware, plumbing, electrical
- furniture, alkosto, ktronix
- repairs, maintenance

Technology:
- apple, samsung, xiaomi, phones
- computers, laptops, tablets
- accessories, headphones, chargers
- falabella tech, alkomprar, mercado libre

Subscriptions:
- memberships, monthly subscriptions
- cloud storage, icloud, google one
- software, adobe, office 365

PARSING RULES:

Amounts:
- Remove: $, dots (.), commas (,)
- "k" or "mil" = ×1000 (e.g., "20k" → 20000, "50mil" → 50000)
- Common Colombian format: $119.000,00 → 119000

Source:
- If text contains "Bancolombia:" or from notificaciones@bancolombia → source: "bancolombia_email"
- If text contains "Nequi:" or mentions number 85954 → source: "nequi_sms"
- Otherwise → source: "manual"

Bank:
- If source is bancolombia_email → bank: "bancolombia"
- If source is nequi_sms → bank: "nequi"
- If manual and not specified → bank: "other"

Payment type:
- If SMS mentions "T.Deb" or "débito" → payment_type: "debit"
- If SMS mentions "Crédito" or "T.Cred" → payment_type: "credit"
- If Nequi SMS → payment_type: "transfer"
- If manual without specification → payment_type: "cash"

Confidence:
- 100: Bank SMS with complete info
- 90: Bank SMS with partial info
- 80-85: Manual message with clear format
- 70-75: Ambiguous manual message
- <70: Very ambiguous or missing critical info

DATES AND TIMES (ONLY for bank SMS):

For MANUAL messages:
- DO NOT include date or time in JSON
- Use: "original_date": null, "original_time": null

For SMS with EXPLICIT date:
- Bancolombia: "el 23/11/2024 a las 19:47"
  → "original_date": "23/11/2024", "original_time": "19:47"
- Nequi: generally NO date
  → "original_date": null, "original_time": null

LAST FOUR DIGITS (for card identification):

For BANK SMS/EMAIL with card number:
- Bancolombia: "con tu T.Deb *7799" or "con tu T.Cred *9934"
  → Extract the 4 digits after the asterisk
  → "last_four": "7799" or "last_four": "9934"
- Look for patterns: "*XXXX", "*NNNN" where X/N are digits
- If found → "last_four": "XXXX" (as string)
- If NOT found → "last_four": null

For MANUAL messages:
- Always use: "last_four": null

IMPORTANT:
- "original_date", "original_time", and "last_four" are OPTIONAL
- Only include them if explicitly present in the text
- The system will use these to match the correct account/card

EXAMPLES:

Input: "20000 en almuerzo"
Output: {
  "amount": 20000,
  "description": "almuerzo",
  "category": "food",
  "bank": "other",
  "payment_type": "cash",
  "source": "manual",
  "confidence": 85,
  "original_date": null,
  "original_time": null,
  "last_four": null
}

Input: "Bancolombia: Compraste $119.000,00 en CODASHOP con tu T.Deb *7799, el 23/11/2024 a las 19:47"
Output: {
  "amount": 119000,
  "description": "CODASHOP",
  "category": "entertainment",
  "bank": "bancolombia",
  "payment_type": "debit",
  "source": "bancolombia_email",
  "confidence": 100,
  "original_date": "23/11/2024",
  "original_time": "19:47",
  "last_four": "7799"
}

Input: "Nequi: Pagaste $50.000 en UBER"
Output: {
  "amount": 50000,
  "description": "UBER",
  "category": "transportation",
  "bank": "nequi",
  "payment_type": "transfer",
  "source": "nequi_sms",
  "confidence": 95,
  "original_date": null,
  "original_time": null,
  "last_four": null
}

IMPORTANT:
- ALWAYS respond with ONLY valid JSON
- DO NOT add markdown (\`\`\`json)
- DO NOT add explanations
- Amount ALWAYS as pure number (without formatting)
`;

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
