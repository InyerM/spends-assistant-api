import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { GeminiResponse } from '../types/expense';
import { automationGenerateSystemPrompt } from '../constants/automation-generate-system-prompt';
import type {
  AutomationRule,
  AutomationRuleConditions,
  AutomationRuleActions,
  RuleType,
  ConditionLogic,
} from '../types/rule';

interface AutomationGenerateRequest {
  prompt: string;
}

interface GeneratedRule {
  name: string;
  is_active: boolean;
  priority: number;
  rule_type: RuleType;
  condition_logic: ConditionLogic;
  conditions: AutomationRuleConditions;
  actions: AutomationRuleActions;
}

export async function handleAutomationGenerate(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    // Resolve user from API key
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const token = authHeader.slice(7);
    let userId = await services.apiKeys.resolveUser(token);

    // Fall back to legacy static API_KEY
    if (!userId && token === env.API_KEY) {
      userId = env.DEFAULT_USER_ID;
    }

    // Fall back to Supabase JWT verification
    if (!userId) {
      try {
        const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: env.SUPABASE_SERVICE_KEY,
          },
        });
        if (userRes.ok) {
          const user = (await userRes.json()) as { id: string };
          userId = user.id;
        }
      } catch {
        // JWT verification failed, userId remains null
      }
    }

    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }

    const body = (await request.json()) as AutomationGenerateRequest;
    const { prompt } = body;

    if (!prompt || !prompt.trim()) {
      return new Response(
        JSON.stringify({ error: 'Missing prompt' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fetch user context in parallel
    const [accounts, categories, existingRules] = await Promise.all([
      services.accounts.getAccounts(userId),
      services.categories.getCategories(userId),
      services.automationRules.getAutomationRules(userId),
    ]);

    // Build dynamic context
    const accountsContext = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
    }));

    const categoriesContext = categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      type: c.type,
    }));

    const existingRulesContext = existingRules.map((r: AutomationRule) => ({
      name: r.name,
      rule_type: r.rule_type,
      conditions: r.conditions,
      actions: r.actions,
    }));

    const dynamicContext = `
USER CONTEXT:

ACCOUNTS (use these IDs in actions):
${JSON.stringify(accountsContext, null, 2)}

CATEGORIES (use these IDs in actions):
${JSON.stringify(categoriesContext, null, 2)}

EXISTING RULES (avoid creating duplicates):
${JSON.stringify(existingRulesContext, null, 2)}
`;

    // Call Gemini API
    const model = 'gemini-2.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: automationGenerateSystemPrompt },
            { text: dynamicContext },
            { text: `User request: "${prompt}"` },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as GeminiResponse;

    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) {
      const finishReason = candidate?.finishReason || 'UNKNOWN';
      throw new Error(`Gemini returned no content (reason: ${finishReason})`);
    }

    const content = candidate.content.parts[0].text;
    const cleanContent = content.replace(/```json\n?|\n?```/g, '').trim();
    const generatedRules = JSON.parse(cleanContent) as GeneratedRule[];

    // Validate that we got an array
    if (!Array.isArray(generatedRules)) {
      throw new Error('Gemini did not return an array of rules');
    }

    // Normalize each rule with defaults
    const rules: GeneratedRule[] = generatedRules.map((rule) => ({
      name: rule.name || 'Unnamed Rule',
      is_active: rule.is_active ?? true,
      priority: rule.priority ?? 50,
      rule_type: rule.rule_type || 'general',
      condition_logic: rule.condition_logic || 'or',
      conditions: rule.conditions || {},
      actions: rule.actions || {},
    }));

    return new Response(
      JSON.stringify({ rules, prompt }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Automation Generate Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
