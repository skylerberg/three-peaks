import { Command } from 'commander';
import type { CliDeps } from './context.ts';
import { VERSION } from './version.ts';
import { registerAuth } from './commands/auth.ts';
import { registerCanva } from './commands/canva.ts';
import { registerCompletion } from './commands/completion.ts';
import { registerComponent } from './commands/component.ts';
import { registerConfig } from './commands/config.ts';
import { registerDeck } from './commands/deck.ts';
import { registerFiles } from './commands/files.ts';
import { registerPrint } from './commands/print.ts';
import { registerProject } from './commands/project.ts';
import { registerStatus } from './commands/status.ts';
import { registerToken } from './commands/token.ts';
import { registerTrash } from './commands/trash.ts';
import { registerUrl } from './commands/url.ts';
import { registerWatch } from './commands/watch.ts';

export function buildProgram(deps: CliDeps): Command {
  // Positional, so the root's own --version is read only before a subcommand
  // and a leaf is free to take a --version <n> of its own.
  const program = new Command('threepeaks')
    .description('CLI for Three Peaks Hub, the board game design tools')
    .version(VERSION)
    .enablePositionalOptions();
  registerAuth(program, deps);
  registerToken(program, deps);
  registerStatus(program, deps);
  registerProject(program, deps);
  registerFiles(program, deps);
  registerTrash(program, deps);
  registerDeck(program, deps);
  registerComponent(program, deps);
  registerPrint(program, deps);
  registerCanva(program, deps);
  registerUrl(program, deps);
  registerWatch(program, deps);
  registerConfig(program, deps);
  registerCompletion(program, deps);
  return program;
}
