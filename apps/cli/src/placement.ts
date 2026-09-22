import { CliError, EXIT } from './errors.ts';
import type { Opts } from './kit.ts';

export type Placement =
  | { kind: 'top' }
  | { kind: 'bottom' }
  | { kind: 'before'; ref: string }
  | { kind: 'after'; ref: string }
  // One-based, the way a listing numbers its rows.
  | { kind: 'position'; position: number };

export function placementFromOpts(opts: Opts): Placement {
  const chosen: Placement[] = [];
  if (opts.top === true) chosen.push({ kind: 'top' });
  if (opts.bottom === true) chosen.push({ kind: 'bottom' });
  if (typeof opts.before === 'string') chosen.push({ kind: 'before', ref: opts.before });
  if (typeof opts.after === 'string') chosen.push({ kind: 'after', ref: opts.after });
  if (typeof opts.position === 'string') {
    const position = Number(opts.position);
    if (!/^\d+$/.test(opts.position) || position < 1) {
      throw new CliError(
        `--position must be a whole number from 1, not "${opts.position}"`,
        EXIT.usage
      );
    }
    chosen.push({ kind: 'position', position });
  }
  if (chosen.length !== 1) {
    throw new CliError(
      'Pass exactly one of --top, --bottom, --before, --after or --position',
      EXIT.usage
    );
  }
  return chosen[0];
}

// The whole list in its new order. An anchor is resolved by the caller into an
// id, because only the caller knows how its rows are named. A position past the
// end is the end, the way dragging past the last row drops it there.
export function reorder(
  ids: readonly string[],
  movingId: string,
  placement: Placement,
  anchorId?: string
): string[] {
  if (!ids.includes(movingId)) {
    throw new Error(`reorder: ${movingId} is not in the list`);
  }
  const rest = ids.filter((id) => id !== movingId);
  let index: number;
  switch (placement.kind) {
    case 'top':
      index = 0;
      break;
    case 'bottom':
      index = rest.length;
      break;
    case 'position':
      index = Math.min(placement.position - 1, rest.length);
      break;
    case 'before':
    case 'after': {
      if (anchorId === undefined) throw new Error('reorder: an anchor needs its id');
      if (anchorId === movingId) {
        throw new CliError('A row cannot be placed relative to itself', EXIT.usage);
      }
      const anchor = rest.indexOf(anchorId);
      if (anchor === -1) throw new Error(`reorder: ${anchorId} is not in the list`);
      index = placement.kind === 'before' ? anchor : anchor + 1;
      break;
    }
  }
  return [...rest.slice(0, index), movingId, ...rest.slice(index)];
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
