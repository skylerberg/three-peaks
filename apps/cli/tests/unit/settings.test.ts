import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DEFAULT_CARD_SETTINGS, DEFAULT_WOOD_SETTINGS } from '@three-peaks/shared';
import {
  applyAssignments,
  formatSettings,
  mergeSettings,
  readSettingsFile,
} from '../../src/settings.ts';
import { CliError, EXIT } from '../../src/errors.ts';
import type { RuntimeContext } from '../../src/context.ts';

// Spread into plain object types: the shared interfaces carry no index
// signature, which the settings helpers' Record constraint asks for.
const WOOD = { ...DEFAULT_WOOD_SETTINGS };
const CARD = { ...DEFAULT_CARD_SETTINGS };

function exitCodeOf(fn: () => unknown): number | null {
  try {
    fn();
  } catch (err) {
    return err instanceof CliError ? err.exitCode : null;
  }
  return null;
}

function contextWithStdin(text: string): RuntimeContext {
  const stdin = new PassThrough();
  stdin.end(text);
  return { deps: { stdin } } as unknown as RuntimeContext;
}

describe('applyAssignments', () => {
  it('coerces each value by the type the stored one already has', () => {
    const next = applyAssignments(WOOD, [
      'thickness_mm=10',
      'printed=yes',
      'wood_color=#aabbcc',
      'trace_source=luminance',
    ]);
    expect(next).toEqual({
      ...WOOD,
      thickness_mm: 10,
      printed: true,
      wood_color: '#aabbcc',
      trace_source: 'luminance',
    });
  });

  it('leaves the object it was given alone', () => {
    const before = { ...WOOD };
    applyAssignments(WOOD, ['thickness_mm=10']);
    expect(WOOD).toEqual(before);
  });

  it('reads the last of two assignments to one key', () => {
    expect(applyAssignments(WOOD, ['seed=2', 'seed=3']).seed).toBe(3);
  });

  it('keeps everything after the first equals sign as the value', () => {
    expect(applyAssignments(WOOD, ['wood_color=a=b']).wood_color).toBe('a=b');
  });

  it('accepts every spelling of a boolean it documents', () => {
    for (const raw of ['true', 'YES', 'on', '1']) {
      expect(applyAssignments(WOOD, [`printed=${raw}`]).printed).toBe(true);
    }
    for (const raw of ['false', 'No', 'off', '0']) {
      expect(applyAssignments({ ...WOOD, printed: true }, [`printed=${raw}`]).printed).toBe(false);
    }
  });

  it('clears a nullable field with null, and sets it with anything else', () => {
    const withBack = applyAssignments(CARD, ['back_file_id=abc']);
    expect(withBack.back_file_id).toBe('abc');
    expect(applyAssignments(withBack, ['back_file_id=null']).back_file_id).toBeNull();
    expect(applyAssignments(CARD, ['back_file_id=']).back_file_id).toBeNull();
  });

  it('refuses a malformed assignment as a usage error', () => {
    expect(exitCodeOf(() => applyAssignments(WOOD, ['thickness_mm']))).toBe(EXIT.usage);
    expect(exitCodeOf(() => applyAssignments(WOOD, ['=3']))).toBe(EXIT.usage);
  });

  it('refuses a key the kind does not have, naming the ones it does', () => {
    try {
      applyAssignments(WOOD, ['width_mm=3']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT.usage);
      expect((err as CliError).message).toContain('No setting "width_mm" on a wood');
      expect((err as CliError).message).toContain('longest_side_mm');
      expect((err as CliError).message).not.toContain('kind,');
    }
  });

  it('refuses to change the kind', () => {
    expect(exitCodeOf(() => applyAssignments(WOOD, ['kind=box']))).toBe(EXIT.usage);
  });

  it('refuses a value that does not fit the type as invalid input', () => {
    for (const raw of ['thickness_mm=thick', 'thickness_mm=', 'thickness_mm=Infinity']) {
      expect(exitCodeOf(() => applyAssignments(WOOD, [raw]))).toBe(EXIT.invalid);
    }
    expect(exitCodeOf(() => applyAssignments(WOOD, ['printed=maybe']))).toBe(EXIT.invalid);
  });
});

describe('mergeSettings', () => {
  it('lays a partial object over what is stored', () => {
    expect(mergeSettings(WOOD, { thickness_mm: 3 })).toEqual({
      ...WOOD,
      thickness_mm: 3,
    });
  });

  it('accepts a patch that restates the same kind', () => {
    expect(mergeSettings(WOOD, { kind: 'wood', seed: 4 }).seed).toBe(4);
  });

  it('refuses a patch for another kind', () => {
    expect(exitCodeOf(() => mergeSettings(WOOD, { kind: 'box' }))).toBe(EXIT.invalid);
  });
});

describe('readSettingsFile', () => {
  it('reads a JSON object from a file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'threepeaks-settings-')), 's.json');
    await writeFile(path, '{"seed": 9}');
    expect(await readSettingsFile(contextWithStdin(''), path)).toEqual({ seed: 9 });
  });

  it('reads stdin for "-"', async () => {
    expect(await readSettingsFile(contextWithStdin('{"seed": 5}'), '-')).toEqual({ seed: 5 });
  });

  it('refuses anything that is not a JSON object', async () => {
    for (const text of ['[1, 2]', 'null', '3', 'not json']) {
      await expect(readSettingsFile(contextWithStdin(text), '-')).rejects.toBeInstanceOf(CliError);
    }
  });

  it('refuses a file that cannot be read', async () => {
    await expect(
      readSettingsFile(contextWithStdin(''), join(tmpdir(), 'no-such-settings-file.json'))
    ).rejects.toMatchObject({ exitCode: EXIT.usage });
  });
});

describe('formatSettings', () => {
  it('lists every field but the kind, sorted, with null spelled out', () => {
    const lines = formatSettings(CARD);
    expect(lines).not.toContainEqual(expect.stringMatching(/^kind /));
    expect(lines).toContain('back_file_id = null');
    expect(lines).toContain('width_mm = 63');
    expect([...lines].sort()).toEqual(lines);
  });
});
