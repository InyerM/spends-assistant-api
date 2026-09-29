import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createLiveResponder, createOracleResponder } from './client';
import { FIXTURES, REFERENCE_DATE, checkFixturePrivacy, checkFixtureShape } from './fixtures';
import { estimateCostUsd, selectModels } from './models';
import { renderReport } from './report';
import { runEvaluation } from './runner';
import type { Fixture, ModelCandidate } from './types';

/** Generous per-call token budget used only for the pre-run spending guard. */
const GUARD_PROMPT_TOKENS = 4_000;
const GUARD_COMPLETION_TOKENS = 500;

export interface CliDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  writeReport?: (name: string, contents: string) => Promise<string>;
  now?: () => Date;
  fixtures?: Fixture[];
}

export interface CliOptions {
  live: boolean;
  models?: string[];
  includeOptional: boolean;
  repeats: number;
  maxUsd: number;
  write: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: 'boolean', default: false },
      models: { type: 'string' },
      'include-optional': { type: 'boolean', default: false },
      repeats: { type: 'string', default: '1' },
      'max-usd': { type: 'string', default: '0.50' },
      'no-write': { type: 'boolean', default: false }
    },
    strict: true
  });
  const repeats = Number(values.repeats);
  const maxUsd = Number(values['max-usd']);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new Error('--repeats must be an integer from 1 to 10');
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    throw new Error('--max-usd must be a positive number');
  return {
    live: values.live ?? false,
    models: values.models
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    includeOptional: values['include-optional'] ?? false,
    repeats,
    maxUsd,
    write: !values['no-write']
  };
}

export function worstCaseCostUsd(models: ModelCandidate[], calls: number): number {
  return models.reduce(
    (sum, model) =>
      sum + estimateCostUsd(model, GUARD_PROMPT_TOKENS, GUARD_COMPLETION_TOKENS) * calls,
    0
  );
}

async function defaultWriteReport(name: string, contents: string): Promise<string> {
  const dir = join(import.meta.dirname, 'results');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

/** Returns a process exit code. Live calls happen only with --live and a local API key. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { log } = deps;
  let options: CliOptions;
  let models: ModelCandidate[];
  try {
    options = parseCliArgs(argv);
    models = selectModels({ ids: options.models, includeOptional: options.includeOptional });
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : 'invalid arguments'}`);
    return 2;
  }

  const fixtures = deps.fixtures ?? FIXTURES;
  const problems = [...checkFixtureShape(fixtures), ...checkFixturePrivacy(fixtures)];
  if (problems.length) {
    log('Fixture checks failed:');
    for (const problem of problems) log(`- ${problem}`);
    return 1;
  }
  log(`Fixture checks passed (${fixtures.length} synthetic fixtures).`);

  let responder = createOracleResponder();
  if (options.live) {
    const apiKey = deps.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      log(
        'Error: --live requires OPENROUTER_API_KEY in the local environment. No requests were sent.'
      );
      return 2;
    }
    const worstCase = worstCaseCostUsd(models, fixtures.length * options.repeats);
    if (worstCase > options.maxUsd) {
      log(
        `Error: worst-case spend $${worstCase.toFixed(4)} exceeds --max-usd $${options.maxUsd.toFixed(2)}. No requests were sent.`
      );
      return 2;
    }
    log(
      `Live run: ${models.map((m) => m.id).join(', ')}; ${fixtures.length * options.repeats} calls per model; worst-case spend $${worstCase.toFixed(4)}.`
    );
    responder = createLiveResponder({ apiKey, fetchImpl: deps.fetchImpl });
  }

  const result = await runEvaluation({
    mode: options.live ? 'live' : 'offline',
    referenceDate: REFERENCE_DATE,
    fixtures,
    models,
    responder,
    repeats: options.repeats
  });

  const generatedAt = (deps.now?.() ?? new Date()).toISOString();
  const report = renderReport(result, generatedAt);
  log(report);

  if (options.write) {
    const stamp = generatedAt.replace(/[:.]/g, '-');
    const write = deps.writeReport ?? defaultWriteReport;
    const path = await write(`${stamp}-${result.mode}.md`, report);
    await write(`${stamp}-${result.mode}.json`, `${JSON.stringify(result, null, 2)}\n`);
    log(`Report written to ${path} (git-ignored).`);
  }

  // Offline mode is a self-test: the oracle must score perfectly or the harness is broken.
  if (!options.live) {
    const broken = result.summaries.filter((s) => s.failures.length || s.jsonValidRate < 1);
    if (broken.length) {
      log('Offline self-test failed: the oracle responder did not score 100%.');
      return 1;
    }
    log('Offline self-test passed.');
  }
  return 0;
}
