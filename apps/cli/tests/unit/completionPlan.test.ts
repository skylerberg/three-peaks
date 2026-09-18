import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { buildProgram } from '../../src/program.ts';
import {
  filterCandidates,
  formatCandidates,
  planCompletion,
  type CompletionPlan,
} from '../../src/completion/plan.ts';

const program = buildProgram({
  env: {},
  platform: 'linux',
  stdin: new PassThrough(),
  stdout: { write: () => true },
  stderr: { write: () => true },
});

function plan(line: string): CompletionPlan {
  // The shell hands over the word under the cursor last, empty when it is new.
  const words = line.split(' ');
  return planCompletion(program, words);
}

function values(p: CompletionPlan): string[] {
  return p.kind === 'static' ? p.items.map((item) => item.value) : [];
}

describe('planCompletion', () => {
  it('offers the top-level commands', () => {
    const top = values(plan('threepeaks '));
    for (const name of ['deck', 'component', 'upload', 'ls', 'watch', 'trash', 'project']) {
      expect(top).toContain(name);
    }
    expect(top).not.toContain('__complete');
  });

  it('offers a group’s subcommands', () => {
    expect(values(plan('threepeaks deck '))).toEqual(
      expect.arrayContaining(['list', 'show', 'upload', 'copies', 'import'])
    );
  });

  it('offers a leaf’s flags', () => {
    expect(values(plan('threepeaks deck show X --'))).toEqual(
      expect.arrayContaining(['--project', '--json', '--all'])
    );
  });

  it('completes a deck by its placeholder, scoped by --project', () => {
    expect(plan('threepeaks deck show --project Summit ')).toEqual({
      kind: 'values',
      valueKind: 'deck',
      scope: { project: 'Summit' },
    });
  });

  it('completes a card against the deck typed before it', () => {
    expect(plan('threepeaks deck copies Heroes ')).toEqual({
      kind: 'values',
      valueKind: 'card',
      scope: { deck: 'Heroes' },
    });
  });

  it('reads --deck and --component as the scope of a file', () => {
    expect(plan('threepeaks download --deck=Heroes ')).toMatchObject({
      valueKind: 'file',
      scope: { deck: 'Heroes' },
    });
    expect(plan('threepeaks download --component Box ')).toMatchObject({
      valueKind: 'file',
      scope: { component: 'Box' },
    });
  });

  it('hands local paths to the shell', () => {
    expect(plan('threepeaks upload ')).toEqual({ kind: 'files' });
    expect(plan('threepeaks deck upload Heroes ')).toEqual({ kind: 'files' });
  });

  it('completes a remote folder rather than a local one', () => {
    expect(plan('threepeaks upload --to ')).toMatchObject({ kind: 'values', valueKind: 'folder' });
  });

  it('uses an option’s choices', () => {
    expect(values(plan('threepeaks component list --kind '))).toEqual([
      'wood',
      'box',
      'board',
      'punchboard',
    ]);
  });

  it('offers the config keys', () => {
    expect(values(plan('threepeaks config set '))).toEqual([
      'api-url',
      'default-project',
      'web-url',
    ]);
  });
});

describe('formatCandidates', () => {
  it('drops values that cannot survive the tab-separated wire format', () => {
    const out = formatCandidates([
      { value: 'ok', description: 'fine' },
      { value: 'bad\tvalue', description: '' },
      { value: 'nl', description: 'two\nlines' },
    ]);
    expect(out).toBe('ok\tfine\nnl\ttwo lines\n');
  });

  it('filters by prefix, case-insensitively, without duplicates', () => {
    const items = [
      { value: 'Heroes', description: '' },
      { value: 'heroes', description: '' },
      { value: 'Heroes', description: 'again' },
      { value: 'Villains', description: '' },
    ];
    expect(filterCandidates(items, 'he').map((i) => i.value)).toEqual(['Heroes', 'heroes']);
  });
});
