import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
function compiled(url: URL): string {
  return ts
    .transpileModule(readFileSync(url, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, removeComments: true }
    })
    .outputText.replace(/,\s*([}\]])/gu, '$1')
    .replace(/\s+/gu, '');
}
it('keeps backend, web and native evidence semantics identical despite repository formatting', () => {
  const canonical = compiled(new URL('../../src/utils/email-event-evidence.ts', import.meta.url));
  expect(
    compiled(
      new URL(
        '../../../spends-assistant-web/lib/shortcut-inbox/email-event-evidence.ts',
        import.meta.url
      )
    )
  ).toBe(canonical);
  expect(
    compiled(
      new URL(
        '../../../spends-assistant-mobile/src/lib/utils/email-event-evidence.ts',
        import.meta.url
      )
    )
  ).toBe(canonical);
});
