import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, basename, resolve } from 'node:path';
const root = process.cwd();
const source = readFileSync(resolve(root, 'src/utils/email-event-evidence.ts'), 'utf8');
for (const target of [
  '../spends-assistant-web/lib/shortcut-inbox/email-event-evidence.ts',
  '../spends-assistant-mobile/src/lib/utils/email-event-evidence.ts'
]) {
  const destination = resolve(root, target);
  writeFileSync(destination, source);
  execFileSync('pnpm', ['exec', 'prettier', '--write', basename(destination)], {
    cwd: dirname(destination),
    stdio: 'pipe'
  });
}
