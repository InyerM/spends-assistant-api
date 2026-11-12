import { RE2JS } from 're2js';

export const MAX_AUTOMATION_RULES = 200;
export const MAX_AUTOMATION_MATCH_INPUT = 8192;
const MAX_PATTERN_LENGTH = 512;
const MAX_PROGRAM_SIZE = 256;
const MAX_TOTAL_PROGRAM_SIZE = 512;
const CACHE_SIZE = 4;

export interface AutomationRegexCompatibility {
  engine: 're2js-unicode-v1';
  requires_review: boolean;
  reason?: 'invalid_type' | 'unsupported_syntax' | 'pattern_limit' | 'complexity_limit';
  program_size: number;
}

export class AutomationMatchingReviewRequiredError extends Error {
  public readonly code = 'AUTOMATION_MATCHING_REVIEW_REQUIRED';
  public constructor(public readonly reason: 'rule_limit' | 'work_limit' | 'input_limit') {
    super('Automation matching requires review');
  }
}

const compiled = new Map<string, RE2JS>();

function compatibility(
  reason?: AutomationRegexCompatibility['reason'],
  programSize = 0
): AutomationRegexCompatibility {
  return {
    engine: 're2js-unicode-v1',
    requires_review: reason !== undefined,
    ...(reason ? { reason } : {}),
    program_size: programSize
  };
}

function preflight(pattern: string): AutomationRegexCompatibility['reason'] | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return 'pattern_limit';
  let depth = 0;
  let characterClass = false;
  let expansion = 1;
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index];
    if (token === '\\') {
      index++;
      continue;
    }
    if (token === '[') characterClass = true;
    if (token === ']' && characterClass) {
      characterClass = false;
      continue;
    }
    if (characterClass) continue;
    if (token === '(') {
      if (++depth > 24) return 'complexity_limit';
      if (pattern[index + 1] === '?' && pattern[index + 2] !== ':') return 'unsupported_syntax';
    }
    if (token === ')') depth--;
    if (token !== '{') continue;
    const end = pattern.indexOf('}', index);
    if (end < 0) continue;
    const count = /^(\d+)(?:,(\d*))?$/u.exec(pattern.slice(index + 1, end));
    if (!count) continue;
    const upper = count.at(2);
    const maximum = Number(upper === '' ? Number(count[1]) + 1 : (upper ?? count[1]));
    if (!Number.isSafeInteger(maximum) || maximum > 32) return 'complexity_limit';
    expansion *= Math.max(1, maximum);
    if (pattern.length * expansion > 512) return 'complexity_limit';
    index = end;
  }
  return undefined;
}

export function inspectAutomationRegex(pattern: unknown): AutomationRegexCompatibility {
  if (pattern === undefined || pattern === null || pattern === '') return compatibility();
  if (typeof pattern !== 'string') return compatibility('invalid_type');
  const rejected = preflight(pattern);
  if (rejected) return compatibility(rejected);
  try {
    let expression = compiled.get(pattern);
    if (!expression) {
      expression = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
      if (expression.programSize() > MAX_PROGRAM_SIZE) return compatibility('complexity_limit');
      if (compiled.size >= CACHE_SIZE) {
        const oldest = compiled.keys().next().value;
        if (oldest !== undefined) compiled.delete(oldest);
      }
      compiled.set(pattern, expression);
    }
    return compatibility(undefined, expression.programSize());
  } catch {
    return compatibility('unsupported_syntax');
  }
}

export function matchesAutomationRegex(pattern: unknown, input: string): boolean {
  if (input.length > MAX_AUTOMATION_MATCH_INPUT) return false;
  const state = inspectAutomationRegex(pattern);
  if (state.requires_review) return false;
  if (!state.program_size) return true;
  const expression = typeof pattern === 'string' ? compiled.get(pattern) : undefined;
  if (!expression) return false;
  try {
    return expression.test(input);
  } catch {
    return false;
  } finally {
    expression.reset();
  }
}

export function assertAutomationMatchInput(description: string, rawText = ''): void {
  if (
    description.length > MAX_AUTOMATION_MATCH_INPUT ||
    rawText.length > MAX_AUTOMATION_MATCH_INPUT
  )
    throw new AutomationMatchingReviewRequiredError('input_limit');
}

export function assertAutomationRuleSet(
  rules: readonly { conditions?: { description_regex?: unknown } | null }[]
): void {
  if (rules.length > MAX_AUTOMATION_RULES)
    throw new AutomationMatchingReviewRequiredError('rule_limit');
  let programSize = 0;
  for (const rule of rules) {
    const state = inspectAutomationRegex(rule.conditions?.description_regex);
    if (!state.requires_review) programSize += state.program_size;
    if (programSize > MAX_TOTAL_PROGRAM_SIZE)
      throw new AutomationMatchingReviewRequiredError('work_limit');
  }
}

export function automationMatchingErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AutomationMatchingReviewRequiredError)) return null;
  return Response.json(
    { error: error.message, code: error.code, reason: error.reason, requires_review: true },
    { status: 422, headers: { 'Cache-Control': 'private, no-store' } }
  );
}
