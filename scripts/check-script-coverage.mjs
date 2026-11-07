// Every `check:*` script has to be run by something. `check:all` is the gate a
// person runs; the workflows are the gate a push runs; a check in neither is a
// file nobody executes.
//
// This exists because that is not hypothetical. check:upload, check:model3d and
// check:a11y were each written with a --selftest arm and a documented "fails
// under CI rather than skipping" contract, and for a year no workflow ran any of
// them -- so the contract never once executed, and the flake in one of them
// survived every green build.
//
// The failure mode is specific to a hand-copied list: check:all names its steps
// in package.json and the workflows name theirs again in YAML, so adding a
// twelfth check to one leaves the other with eleven and nothing says so.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const selftest = process.argv.includes('--selftest');

// A denial written down rather than left out: an omission and an exemption look
// identical from here, and only one of them was a decision.
const EXEMPT = {
  'check:all': 'the aggregate itself',
};

function scriptNames(pkg) {
  return Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith('check:'));
}

// Not a bare substring test: `check:test-guards` occurs inside
// `check:test-guards:anchors`, and a workflow running only the subset would
// otherwise count as running the whole thing.
function mentions(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![\\w:-])`).test(haystack);
}

function workflowSources() {
  const dir = new URL('.github/workflows/', root);
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => readFileSync(new URL(file, dir), 'utf8'))
    .join('\n');
}

function uncovered(pkg, workflows) {
  const runAll = pkg.scripts?.['check:all'] ?? '';
  return scriptNames(pkg).filter((name) => {
    if (name in EXEMPT) return false;
    return !mentions(runAll, name) && !mentions(workflows, name);
  });
}

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'));
const workflows = workflowSources();
const problems = uncovered(pkg, workflows);

if (selftest) {
  // Sensitivity: a check that measures nothing reports green exactly like one
  // that passes. Prove an uncovered script is actually seen.
  const planted = { scripts: { ...pkg.scripts, 'check:nobody-runs-this': 'exit 0' } };
  const found = uncovered(planted, workflows);
  if (!found.includes('check:nobody-runs-this')) {
    console.error('[selftest] FAILED: an unrun check was not reported');
    process.exit(1);
  }
  console.log('[selftest] a check that nothing runs is reported, as expected');
}

if (problems.length > 0) {
  console.error(`${problems.length} check script(s) that nothing runs:\n`);
  for (const name of problems) console.error(`  ${name}`);
  console.error(
    '\nAdd it to check:all, or to a workflow, or write down why not in the EXEMPT' +
      '\nmap in scripts/check-script-coverage.mjs.'
  );
  process.exit(1);
}

const counted = scriptNames(pkg).length - Object.keys(EXEMPT).length;
console.log(`check:scripts passed (${counted} check scripts, each run by check:all or a workflow)`);
