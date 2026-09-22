import { Command, CommanderError } from 'commander';
import { buildProgram } from './program.ts';
import { ApiError, CliError, EXIT, exitCodeForStatus } from './errors.ts';
import type { CliDeps } from './context.ts';

// `.addCommand()` does not inherit these from the root the way `.command()` does.
function configureTree(cmd: Command, deps: CliDeps): void {
  cmd.exitOverride();
  cmd.configureOutput({
    writeOut: (str) => deps.stdout.write(str),
    writeErr: (str) => deps.stderr.write(str),
  });
  for (const sub of cmd.commands) {
    configureTree(sub, deps);
  }
}

export async function run(deps: CliDeps, argv: string[]): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);
  try {
    await program.parseAsync(argv);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof CliError) {
      deps.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof ApiError) {
      deps.stderr.write(`${err.message}\n`);
      if (err.status === 401) {
        deps.stderr.write(
          'Not authenticated, or the credential was refused. Run: threepeaks login\n'
        );
      }
      return exitCodeForStatus(err.status);
    }
    deps.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.failure;
  }
}
