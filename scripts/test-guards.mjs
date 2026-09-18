// Mutation testing. Each entry names a bug and the exact edit that puts it
// back; the runner requires the named tests to FAIL with that edit in place.
//
// This exists because a unit test can measure nothing and still report green --
// a stale expectation, a fixture that stopped reaching the code path, an
// assertion that was already true before the fix. A guard whose tests still
// pass has stopped guarding anything, and nothing else in the repo can tell you
// that.
//
// Rules for adding one:
//   * `find` must match EXACTLY ONCE in the file. A pattern that matches
//     nothing leaves the source correct and the tests green, which is
//     indistinguishable from a guard that works.
//   * `testName` should be narrow enough that exactly one case fails. A widened
//     name can turn a five-second failure into a run with no upper bound.
//   * The bug should be one a reviewer would plausibly introduce, not a
//     syntactic nonsense that fails to compile.
//   * `runner` names the package the tests run in, and defaults to `api`. It is
//     the only field saying where a guard belongs -- there was a second one for
//     a while, unread, and on nine guards it disagreed with this one.

// Entries live in `scripts/test-guards/`, one file per area, because a single
// list is one line every branch appends to and therefore a merge conflict
// between any two of them -- which is what this shape is for, rather than
// tidiness. Put a new guard in the file its subject belongs to; a new area is
// a new file plus two lines here.

import { guards as auth } from './test-guards/auth.mjs';
import { guards as files } from './test-guards/files.mjs';
import { guards as fileversions } from './test-guards/file-versions.mjs';
import { guards as softdelete } from './test-guards/soft-delete.mjs';
import { guards as decks } from './test-guards/decks.mjs';
import { guards as imports } from './test-guards/imports.mjs';
import { guards as print } from './test-guards/print.mjs';
import { guards as model3d } from './test-guards/model3d.mjs';
import { guards as scene } from './test-guards/scene.mjs';
import { guards as platform } from './test-guards/platform.mjs';

// Names are what the runner's filter matches and what its report prints, so two
// files holding the same one is a guard that cannot be selected and a result
// nobody can attribute -- the way a copy lands in the wrong area file.
const areas = [
  auth,
  files,
  fileversions,
  softdelete,
  decks,
  imports,
  print,
  model3d,
  scene,
  platform,
];
const named = areas.flat();
const duplicated = named
  .map((guard) => guard.name)
  .filter((name, at, all) => all.indexOf(name) !== at);
if (duplicated.length > 0) {
  throw new Error(
    `test-guards: ${duplicated.length} duplicate guard name(s): ${duplicated.join(', ')}`
  );
}

export const guards = named;
