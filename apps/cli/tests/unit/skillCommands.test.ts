import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { Command } from 'commander';
import { buildProgram } from '../../src/program.ts';

// The skill's command list is what an agent reads instead of --help, so a
// command it does not mention is one no agent reaches for, and one it names that
// is gone is a command an agent runs and gets a usage error from.
function leafPaths(cmd: Command, prefix: string[] = []): string[] {
  return cmd.commands
    .filter((sub) => !sub.name().startsWith('__'))
    .flatMap((sub) =>
      sub.commands.length > 0
        ? leafPaths(sub, [...prefix, sub.name()])
        : [[...prefix, sub.name()].join(' ')]
    );
}

describe('skill/commands.md', () => {
  const program = buildProgram({
    env: {},
    platform: 'linux',
    stdin: new PassThrough(),
    stdout: { write: () => true },
    stderr: { write: () => true },
  });
  const leaves = leafPaths(program);

  async function listed(): Promise<string[]> {
    const text = await readFile(new URL('../../skill/commands.md', import.meta.url), 'utf8');
    return [...text.matchAll(/^- `threepeaks ([a-z][a-z-]*(?: [a-z][a-z-]*)*)/gm)].map((m) => m[1]);
  }

  it('lists every command the program has', async () => {
    const names = await listed();
    expect(leaves.filter((leaf) => !names.includes(leaf))).toEqual([]);
  });

  it('lists no command the program does not have', async () => {
    const names = await listed();
    expect(names.filter((name) => !leaves.includes(name))).toEqual([]);
  });
});
