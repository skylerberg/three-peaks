// Reads the prose -- code comments, AGENTS.md, README.md -- and fails on two
// things a reader takes on trust:
//
//   * the same sentence in two files, where whichever copy is not next to the
//     code goes stale silently;
//   * a file or symbol named in prose that no longer resolves.
//
// It reads the docs as well as the code because docs drift worse: nothing about
// a stale README is anyone's compile error.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const selftest = process.argv.includes('--selftest');

const SCAN_DIRS = ['apps', 'packages', 'scripts', 'infra', 'tools'];
const DOC_FILES = [
  'AGENTS.md',
  'README.md',
  'packages/shared/README.md',
  'infra/terraform/README.md',
  'tools/blender/README.md',
];
const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  'data',
  '.terraform',
  '__pycache__',
]);
const CODE = /\.(ts|mjs|js|svelte|tf|ya?ml|py|sh)$/;
// Generated files carry a header their generator wrote, so they duplicate it by
// construction. They are output, not prose.
const GENERATED = /\.generated\.ts$/;

const allowlistPath = join(root, 'scripts', 'comment-allowlist.txt');
const allowlist = existsSync(allowlistPath)
  ? new Set(
      readFileSync(allowlistPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
    )
  : new Set();

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) walk(path, out);
    else if (CODE.test(entry) && !GENERATED.test(entry)) out.push(path);
  }
  return out;
}

function extractSentences(text) {
  return (
    text
      .split(/(?<=[.!?])\s+|\n/)
      .map((sentence) =>
        sentence
          .replace(/^[\s/*#>-]+/, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      // Long enough to be a claim rather than a fragment; short enough that a
      // whole paragraph is not one "sentence".
      .filter((sentence) => sentence.length >= 60 && sentence.length <= 400)
  );
}

const HASH_COMMENTED = /\.(tf|ya?ml|sh|py)$/;

function commentsOf(source, path) {
  if (HASH_COMMENTED.test(path)) {
    const lines = source.split('\n').filter((line) => /^\s*#/.test(line));
    // A Python module's rules are written in its docstrings rather than beside a
    // hash, so reading only the hash lines would leave the half that explains
    // the design unguarded.
    const docstrings = path.endsWith('.py')
      ? (source.match(/"""[\s\S]*?"""/g) ?? []).map((block) => block.slice(3, -3))
      : [];
    return [...docstrings, ...lines].join('\n');
  }
  const lines = source.split('\n').filter((line) => /^\s*(\/\/|\*|\/\*)/.test(line));
  return lines.join('\n');
}

const files = SCAN_DIRS.filter((dir) => existsSync(join(root, dir))).flatMap((dir) =>
  walk(join(root, dir))
);

// --- duplicated sentences ---------------------------------------------------
const seen = new Map();
const duplicates = [];

function record(sentence, where) {
  if (allowlist.has(sentence)) return;
  const previous = seen.get(sentence);
  if (previous && previous !== where) {
    duplicates.push({ sentence, first: previous, second: where });
    return;
  }
  seen.set(sentence, where);
}

for (const path of files) {
  const where = relative(root, path);
  for (const sentence of extractSentences(commentsOf(readFileSync(path, 'utf8'), path))) {
    record(sentence, where);
  }
}

for (const doc of DOC_FILES) {
  const path = join(root, doc);
  if (!existsSync(path)) continue;
  for (const sentence of extractSentences(readFileSync(path, 'utf8'))) record(sentence, doc);
}

// --- references that no longer resolve --------------------------------------
// Only paths that look like real repository paths, so ordinary prose is not
// mistaken for a reference.
const PATH_REFERENCE =
  /\b((?:apps|packages|infra|scripts|tools)\/[A-Za-z0-9_./-]+\.[A-Za-z]{2,6})\b/g;
const unresolved = [];

// A path the repository deliberately does not contain is not a dangling
// reference: apps/api/.env is *supposed* to be absent from a fresh clone, which
// is precisely what the README explaining it says. Ask git rather than guess.
function isDeliberatelyAbsent(target) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', target], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function checkReferences(text, where) {
  for (const match of text.matchAll(PATH_REFERENCE)) {
    const target = match[1].replace(/[.,)]+$/, '');
    if (existsSync(join(root, target))) continue;
    if (isDeliberatelyAbsent(target)) continue;
    unresolved.push({ target, where });
  }
}

for (const path of files) {
  checkReferences(commentsOf(readFileSync(path, 'utf8'), path), relative(root, path));
}
for (const doc of DOC_FILES) {
  const path = join(root, doc);
  if (existsSync(path)) checkReferences(readFileSync(path, 'utf8'), doc);
}

// --- selftest ---------------------------------------------------------------
if (selftest) {
  const planted =
    'This sentence is planted by the check-comments selftest and must be reported as a duplicate.';
  const before = duplicates.length;
  record(planted, 'selftest/a.ts');
  record(planted, 'selftest/b.ts');
  if (duplicates.length !== before + 1) {
    console.error('[selftest] FAILED: a planted duplicate was not reported');
    process.exit(1);
  }
  duplicates.pop();

  const missing = [];
  const saved = unresolved.length;
  checkReferences('see apps/api/src/does-not-exist.ts for details', 'selftest');
  if (unresolved.length !== saved + 1) {
    console.error('[selftest] FAILED: a planted dead reference was not reported');
    process.exit(1);
  }
  unresolved.pop();
  void missing;
  console.log('[selftest] a planted duplicate and a planted dead reference are both reported');
}

// --- report -----------------------------------------------------------------
let failed = false;

if (duplicates.length > 0) {
  failed = true;
  console.error(`\n${duplicates.length} duplicated sentence(s):`);
  for (const entry of duplicates) {
    console.error(`  "${entry.sentence.slice(0, 90)}..."`);
    console.error(`    ${entry.first}`);
    console.error(`    ${entry.second}`);
  }
  console.error(
    '\nGive the rule one owner -- the module that implements it -- and cut the other copy\n' +
      'down to what is local to its own site. scripts/comment-allowlist.txt is for the\n' +
      'narrow case where a fact is genuinely needed at two sites.'
  );
}

if (unresolved.length > 0) {
  failed = true;
  console.error(`\n${unresolved.length} reference(s) that no longer resolve:`);
  for (const entry of unresolved) console.error(`  ${entry.where} -> ${entry.target}`);
}

if (!failed) {
  console.log(`check:comments passed (${files.length} files, ${seen.size} sentences)`);
}
process.exit(failed ? 1 : 0);
