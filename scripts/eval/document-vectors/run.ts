import { runEvaluation } from './benchmark';
import { createOpenRouterEmbedder } from './client';
import { SYNTHETIC_CASES } from './fixtures';

async function main(): Promise<void> {
  const live = process.argv.slice(2).includes('--live');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--live');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const embed = live
    ? createOpenRouterEmbedder({ apiKey: process.env.OPENROUTER_API_KEY ?? '' })
    : undefined;
  const report = await runEvaluation(SYNTHETIC_CASES, embed);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Evaluation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
