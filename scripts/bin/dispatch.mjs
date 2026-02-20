import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSetupCliPaths } from '../setup-cli-paths.mjs';

const EXECUTABLE_TO_COMMAND = new Map([
  ['dev-crew-setup-cli-paths.mjs', 'setup-cli-paths'],
  ['dev-crew-setup-cli-paths', 'setup-cli-paths'],
  ['setup-cli-paths', 'setup-cli-paths'],
]);

function helpText() {
  return `Usage:
  dev-crew <command> [options]
  dev-crew-setup-cli-paths [options]

Commands:
  setup-cli-paths    Bind ~/.codex|~/.claude|~/.gemini agents/skills to repo paths.
  help               Show this help.

Examples:
  dev-crew setup-cli-paths --dry-run
  dev-crew-setup-cli-paths --strict
`;
}

function resolveCommand(invokedPath, argv) {
  const invokedName = path.basename(invokedPath ?? '');
  const mapped = EXECUTABLE_TO_COMMAND.get(invokedName);
  if (mapped) {
    return { command: mapped, args: argv };
  }

  if (argv.length === 0) {
    return { command: 'help', args: [] };
  }

  return { command: argv[0], args: argv.slice(1) };
}

export async function runBinCommand(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const invokedPath = options.invokedPath ?? process.argv[1];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const { command, args } = resolveCommand(invokedPath, argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    stdout.write(helpText());
    return 0;
  }

  if (command === 'setup-cli-paths') {
    return runSetupCliPaths({ argv: args, env, stdout, stderr });
  }

  stderr.write(`Unknown command: ${command}\n`);
  stderr.write(helpText());
  return 1;
}

async function main() {
  const exitCode = await runBinCommand();
  process.exitCode = exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
