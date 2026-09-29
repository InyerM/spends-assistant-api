export type FixtureCategory =
  | 'bank_sms'
  | 'bank_email'
  | 'transfer'
  | 'nequi'
  | 'manual'
  | 'non_transaction'
  | 'ambiguous_date';

/** Fields the harness scores. A fixture only scores the fields it lists. */
export type ScoredField =
  | 'amount'
  | 'category'
  | 'bank'
  | 'payment_type'
  | 'source'
  | 'original_date'
  | 'original_time'
  | 'last_four'
  | 'account_type';

export type ExpectedValue = string | number | null;

export interface Fixture {
  id: string;
  category: FixtureCategory;
  /** Synthetic text only. Never paste real messages here. */
  text: string;
  expected: {
    is_transaction: boolean;
    /** Each field accepts one value or a list of acceptable values. */
    fields?: Partial<Record<ScoredField, ExpectedValue | ExpectedValue[]>>;
  };
}

export interface ModelCandidate {
  id: string;
  label: string;
  /** USD per million tokens, from the OpenRouter listing on the plan date. */
  price: { input: number; output: number };
  /** Optional models run only with --include-optional. */
  optional: boolean;
}

export type CallErrorKind = 'http' | 'timeout' | 'invalid_json' | 'empty' | 'truncated' | 'network';

export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
  /** Cost reported by OpenRouter. Null when the provider did not report it. */
  costUsd: number | null;
}

export interface CallResult {
  latencyMs: number;
  usage: CallUsage | null;
  /** Parsed JSON object, or null when the call failed. */
  data: Record<string, unknown> | null;
  error: CallErrorKind | null;
  /** HTTP status only. Upstream bodies can echo private text, so they are never kept. */
  status?: number;
}

export type Responder = (fixture: Fixture, model: ModelCandidate) => Promise<CallResult>;

export interface FixtureScore {
  fixtureId: string;
  category: FixtureCategory;
  jsonValid: boolean;
  schemaValid: boolean;
  expectedTransaction: boolean;
  predictedTransaction: boolean | null;
  fieldsTotal: number;
  fieldsCorrect: number;
  /** Names of mismatched fields. Values are omitted to keep reports content-free. */
  mismatchedFields: string[];
  latencyMs: number;
  usage: CallUsage | null;
  error: CallErrorKind | null;
}

export interface ModelSummary {
  modelId: string;
  label: string;
  runs: number;
  jsonValidRate: number;
  schemaValidRate: number;
  detectionAccuracy: number;
  falseTransactionRate: number | null;
  missedTransactionRate: number | null;
  fieldAccuracy: number | null;
  fieldAccuracyByCategory: Partial<Record<FixtureCategory, number>>;
  latencyP50Ms: number;
  latencyP95Ms: number;
  observedCostUsd: number | null;
  estimatedCostUsd: number;
  costCoverage: number;
  costPer1kUsd: number;
  failures: Array<{ fixtureId: string; reasons: string[] }>;
}

export interface Verdict {
  winner: string | null;
  uncertain: boolean;
  reason: string;
}
