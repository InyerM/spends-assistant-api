import { runCli } from './cli';

// Entry point. See scripts/eval/text-models/README.md for the offline and live commands.
runCli(process.argv.slice(2), {
  env: process.env,
  log: (line) => console.log(line)
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Print the error class only: messages from upstream code could include request context.
    console.error(`Evaluation failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    process.exitCode = 1;
  }
);
