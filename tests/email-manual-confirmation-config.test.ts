import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('requires manual approval for forwarded financial activity in production', () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  expect(config).toMatch(/^EMAIL_AUTO_POST_READY = "false"$/mu);
});
