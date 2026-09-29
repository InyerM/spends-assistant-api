import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { completeJson } from '../ai/openrouter';
import { automationGenerateSystemPrompt } from '../constants/automation-generate-system-prompt';
import { resolveUserId, unauthorizedResponse } from '../utils/auth';
import type {
  AutomationRule,
  AutomationRuleConditions,
  AutomationRuleActions,
  RuleType,
  ConditionLogic
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

export async function handleAutomationGenerate(request: Request, env: Env): Promise<Response> {
  try {
    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const userId = await resolveUserId(request, env, services.apiKeys);
    if (!userId) return unauthorizedResponse();

    const body = (await request.json()) as AutomationGenerateRequest;
    const { prompt } = body;

    if (!prompt || !prompt.trim()) {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch user context in parallel
    const [accounts, categories, existingRules] = await Promise.all([
      services.accounts.getAccounts(userId),
      services.categories.getCategories(userId),
      services.automationRules.getAutomationRules(userId)
    ]);

    // Build dynamic context
    const accountsContext = accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type
    }));

    const categoriesContext = categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      type: c.type
    }));

    const existingRulesContext = existingRules.map((r: AutomationRule) => ({
      name: r.name,
      rule_type: r.rule_type,
      conditions: r.conditions,
      actions: r.actions
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

    const { data } = await completeJson<{ rules: GeneratedRule[] }>({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_TEXT_MODEL ?? 'deepseek/deepseek-v4.1-flash',
      system: `${automationGenerateSystemPrompt}\nReturn a JSON object with a "rules" array.`,
      user: `${dynamicContext}\nUser request: ${prompt}`
    });
    const generatedRules = data.rules;

    // Validate that we got an array
    if (!Array.isArray(generatedRules)) {
      throw new Error('OpenRouter did not return an array of rules');
    }

    // Normalize each rule with defaults
    const rules: GeneratedRule[] = generatedRules.map((rule) => ({
      name: rule.name || 'Unnamed Rule',
      is_active: rule.is_active ?? true,
      priority: rule.priority ?? 50,
      rule_type: rule.rule_type || 'general',
      condition_logic: rule.condition_logic || 'or',
      conditions: rule.conditions || {},
      actions: rule.actions || {}
    }));

    return new Response(JSON.stringify({ rules, prompt }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: unknown) {
    console.error('Automation Generate Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
