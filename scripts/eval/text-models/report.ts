import { formatPercent, qualityScore } from './scoring';
import type { EvaluationResult } from './runner';

function usd(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

/**
 * Renders a Markdown report. It contains fixture ids, field names, and aggregates only:
 * no message text and no model output, so it is safe to paste into an issue.
 */
export function renderReport(result: EvaluationResult, generatedAt: string): string {
  const lines: string[] = [
    '# Text model evaluation',
    '',
    `- Mode: **${result.mode}**${result.mode === 'offline' ? ' (oracle responder; validates the harness, not any model)' : ''}`,
    `- Generated: ${generatedAt}`,
    `- Fixtures: ${result.fixtureCount} synthetic × ${result.repeats} repeat(s); reference date ${result.referenceDate}`,
    `- Verdict: **${result.verdict.winner ?? 'none'}**${result.verdict.uncertain ? ' (uncertain)' : ''}. ${result.verdict.reason}`,
    '',
    '| Model | Quality | Field acc. | Detection | False tx | Missed tx | JSON valid | Schema valid | p50 / p95 ms | Cost (observed) | Cost (est.) | Per 1k |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];

  for (const s of result.summaries) {
    lines.push(
      `| ${s.modelId} | ${qualityScore(s).toFixed(3)} | ${formatPercent(s.fieldAccuracy)} | ${formatPercent(s.detectionAccuracy)} | ${formatPercent(s.falseTransactionRate)} | ${formatPercent(s.missedTransactionRate)} | ${formatPercent(s.jsonValidRate)} | ${formatPercent(s.schemaValidRate)} | ${s.latencyP50Ms} / ${s.latencyP95Ms} | ${usd(s.observedCostUsd)} (${formatPercent(s.costCoverage)} reported) | ${usd(s.estimatedCostUsd)} | ${usd(s.costPer1kUsd)} |`
    );
  }

  lines.push('', '## Accuracy by fixture category', '');
  const categories = [
    ...new Set(result.summaries.flatMap((s) => Object.keys(s.fieldAccuracyByCategory)))
  ].sort();
  lines.push(
    `| Model | ${categories.join(' | ')} |`,
    `| --- |${' ---: |'.repeat(categories.length)}`
  );
  for (const s of result.summaries) {
    const cells = categories.map((c) =>
      formatPercent(s.fieldAccuracyByCategory[c as keyof typeof s.fieldAccuracyByCategory] ?? null)
    );
    lines.push(`| ${s.modelId} | ${cells.join(' | ')} |`);
  }

  lines.push('', '## Mismatches (fixture id: fields)', '');
  for (const s of result.summaries) {
    lines.push(`**${s.modelId}**: ${s.failures.length ? '' : 'none'}`);
    for (const failure of s.failures)
      lines.push(`- ${failure.fixtureId}: ${failure.reasons.join(', ')}`);
    lines.push('');
  }

  lines.push(
    'Quality = 0.5 × field accuracy + 0.3 × detection + 0.2 × schema validity − 0.2 × false-transaction rate.',
    'Observed cost comes from OpenRouter `usage.cost`; the estimate uses listed per-token prices.'
  );
  return `${lines.join('\n')}\n`;
}
