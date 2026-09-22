import { describe, expect, it } from 'vitest';
import { placementFromOpts, reorder, sameOrder } from '../../src/placement.ts';
import { CliError, EXIT } from '../../src/errors.ts';

const ids = ['a', 'b', 'c', 'd'];

describe('reorder', () => {
  it('moves to either end', () => {
    expect(reorder(ids, 'c', { kind: 'top' })).toEqual(['c', 'a', 'b', 'd']);
    expect(reorder(ids, 'b', { kind: 'bottom' })).toEqual(['a', 'c', 'd', 'b']);
  });

  it('places before and after an anchor, whichever side it starts on', () => {
    expect(reorder(ids, 'd', { kind: 'before', ref: 'b' }, 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(reorder(ids, 'a', { kind: 'before', ref: 'c' }, 'c')).toEqual(['b', 'a', 'c', 'd']);
    expect(reorder(ids, 'a', { kind: 'after', ref: 'c' }, 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(ids, 'd', { kind: 'after', ref: 'a' }, 'a')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('counts a position from one, and treats one past the end as the end', () => {
    expect(reorder(ids, 'd', { kind: 'position', position: 1 })).toEqual(['d', 'a', 'b', 'c']);
    expect(reorder(ids, 'a', { kind: 'position', position: 3 })).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(ids, 'a', { kind: 'position', position: 99 })).toEqual(['b', 'c', 'd', 'a']);
  });

  it('refuses to anchor a row on itself', () => {
    expect(() => reorder(ids, 'b', { kind: 'after', ref: 'b' }, 'b')).toThrow(CliError);
  });

  it('can land a row exactly where it was', () => {
    expect(sameOrder(ids, reorder(ids, 'b', { kind: 'after', ref: 'a' }, 'a'))).toBe(true);
    expect(sameOrder(ids, reorder(ids, 'a', { kind: 'top' }))).toBe(true);
    expect(sameOrder(ids, ['a', 'b', 'd', 'c'])).toBe(false);
  });
});

describe('placementFromOpts', () => {
  it('reads each flag', () => {
    expect(placementFromOpts({ top: true })).toEqual({ kind: 'top' });
    expect(placementFromOpts({ bottom: true })).toEqual({ kind: 'bottom' });
    expect(placementFromOpts({ before: 'x' })).toEqual({ kind: 'before', ref: 'x' });
    expect(placementFromOpts({ after: 'x' })).toEqual({ kind: 'after', ref: 'x' });
    expect(placementFromOpts({ position: '2' })).toEqual({ kind: 'position', position: 2 });
  });

  it('wants exactly one', () => {
    for (const opts of [{}, { top: true, bottom: true }, { top: true, position: '1' }]) {
      try {
        placementFromOpts(opts);
        expect.unreachable();
      } catch (err) {
        expect((err as CliError).exitCode).toBe(EXIT.usage);
      }
    }
  });

  it('refuses a position that is not a whole number from one', () => {
    for (const position of ['0', '-1', '1.5', 'two', '']) {
      expect(() => placementFromOpts({ position })).toThrow(CliError);
    }
  });
});
