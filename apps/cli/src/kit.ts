import { Command } from 'commander';
import { createContext, type CliDeps, type GlobalFlags, type RuntimeContext } from './context.ts';
import { DEFAULT_API_URL } from './config.ts';

export function leaf(name: string): Command {
  return new Command(name)
    .option('--json', 'output JSON instead of human-readable text')
    .option('--api-url <url>', `API base URL (default ${DEFAULT_API_URL})`)
    .option('--no-input', 'never prompt; fail if input would be required')
    .option('--no-color', 'disable colored output');
}

// Every command that works inside a project takes this, and resolves it with
// projectFromOpts.
export function inProject(cmd: Command): Command {
  return cmd.option(
    '--project <project>',
    'project id or name (default: THREEPEAKS_PROJECT, then the configured default-project)'
  );
}

// A group rather than a leaf: the options above belong on the commands that
// run, and commander would otherwise list them against every parent.
export function group(name: string, description: string): Command {
  return new Command(name).description(description);
}

export type Opts = Record<string, unknown>;

export function withCtx(
  deps: CliDeps,
  handler: (ctx: RuntimeContext, opts: Opts, ...positionals: string[]) => Promise<void>
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.optsWithGlobals<Opts>();
    const flags: GlobalFlags = {
      json: opts.json === true,
      apiUrl: typeof opts.apiUrl === 'string' ? opts.apiUrl : undefined,
      noInput: opts.input === false,
      color: opts.color !== false,
    };
    const ctx = await createContext(deps, flags);
    const positionals = args.slice(0, -2) as string[];
    await handler(ctx, opts, ...positionals);
  };
}

export function optString(opts: Opts, key: string): string | undefined {
  const value = opts[key];
  return typeof value === 'string' ? value : undefined;
}

export function optList(opts: Opts, key: string): string[] {
  const value = opts[key];
  return Array.isArray(value) ? (value as string[]) : [];
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
