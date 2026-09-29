import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../supabase/migrations/20260929000000_ai_usage_telemetry.sql', import.meta.url),
  'utf8'
);

describe('AI usage telemetry migration', () => {
  it('stores only metadata and cascades user erasure', () => {
    expect(migration).toMatch(/CREATE TABLE ai_usage_events/);
    expect(migration).toMatch(
      /user_id UUID NOT NULL REFERENCES auth\.users\(id\) ON DELETE CASCADE/
    );
    expect(migration).toMatch(/estimated_cost_micros BIGINT CHECK \(estimated_cost_micros >= 0\)/);
    expect(migration).not.toMatch(/prompt_text|response_text|raw_text|receipt_data/i);
  });

  it('limits reads to the service role and provides an internal monthly report', () => {
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON ai_usage_events FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/CREATE VIEW ai_usage_monthly WITH \(security_invoker = true\)/);
    expect(migration).toMatch(/GRANT SELECT ON ai_usage_monthly TO service_role/);
  });
});
