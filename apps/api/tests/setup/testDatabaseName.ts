import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, not apps/api: this file sits at apps/api/tests/setup/, so the
// checkout is four levels up. Getting this wrong still gives every worktree a
// distinct database (the paths differ), but the name and the pruning comment
// both stop describing the checkout they belong to.
export const checkoutRoot = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

export const CHECKOUT_COMMENT_PREFIX = 'three-peaks test checkout: ';

const MAX_IDENTIFIER_LENGTH = 63;

export function baseDatabaseName(): string {
  return process.env.TEST_DB_BASE ?? process.env.DB_DATABASE ?? 'three_peaks_hub_test';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Derived from the checkout path, never configured. Two worktrees running the
// suite at once would otherwise share one database, and the opening TRUNCATE
// would delete rows the other run had already created — which surfaces as one
// unrelated test failing on a wrong status and passing on the rerun.
export function resolveTestDatabaseName(): string {
  const base = baseDatabaseName();
  const label = slugify(basename(checkoutRoot));
  const hash = createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 8);

  const suffix = `_${label}_${hash}`;
  const room = MAX_IDENTIFIER_LENGTH - suffix.length;
  return `${base.slice(0, Math.max(1, room))}${suffix}`;
}

// Only a database whose name still looks like a derived test database may be
// truncated or dropped.
export const RESETTABLE_DATABASE = /^[a-z][a-z0-9_]*_test(_[a-z0-9_]+)?$/;
