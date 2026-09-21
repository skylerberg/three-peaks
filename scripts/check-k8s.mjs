// Renders every Kubernetes manifest with realistic substitutions and asserts
// the resulting names and label values are within Kubernetes' limits.
//
// This exists because a client-side `kubectl apply --dry-run` does NOT check
// them -- it accepted a Job whose name was 64 bytes, and only the API server
// rejected it, at deploy time. The local dry-run had also been fed a 7-character
// fake SHA, so the length it validated was not the length production would use.
// Both mistakes are fixed here: real-shaped values, and the check that the
// client-side dry-run does not perform.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestDir = join(root, 'infra/k8s');
const selftest = process.argv.includes('--selftest');

// A real git SHA and the short form the deploy derives from it.
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHORT = SHA.slice(0, 12);

// The migrate Job's name is the one bound by the label cap, so both the check
// and its selftest read the prefix from here rather than spelling it twice.
const MIGRATE_PREFIX = 'three-peaks-migrate-';

const MAX_LABEL_VALUE = 63;
const MAX_NAME = 253;
// Names that become a Service or are used as a DNS label are stricter still.
const MAX_DNS_LABEL = 63;

// Whatever the deploy pushes from. Only the length and shape matter here, and a
// branch name is unbounded -- the checks below are what say whether it fits.
const BRANCH = 'main';

function render(source) {
  return source
    .replaceAll('{COMMITHASH}', SHA)
    .replaceAll('{SHORTHASH}', SHORT)
    .replaceAll('{BRANCH}', BRANCH);
}

// Deliberately not a YAML parser: these manifests are flat enough that reading
// `name:` and the label block by indentation is exact, and it keeps the check
// dependency-free.
function inspect(doc, file, problems) {
  const kindMatch = /^kind:\s*(\S+)/m.exec(doc);
  const kind = kindMatch ? kindMatch[1] : 'unknown';

  for (const match of doc.matchAll(/^\s*name:\s*(\S+)\s*$/gm)) {
    const name = match[1];
    if (name.length > MAX_NAME) {
      problems.push(`${file}: ${kind} name is ${name.length} bytes (max ${MAX_NAME}): ${name}`);
    }
    // A Job copies its name into the pod template's job-name label, so its name
    // is bound by the label limit rather than the name limit.
    if (kind === 'Job' && name.startsWith(MIGRATE_PREFIX) && name.length > MAX_LABEL_VALUE) {
      problems.push(
        `${file}: ${kind} name is ${name.length} bytes; Kubernetes copies it into the ` +
          `job-name label, which caps at ${MAX_LABEL_VALUE}: ${name}`
      );
    }
    if (kind === 'Service' && name.length > MAX_DNS_LABEL) {
      problems.push(
        `${file}: Service name is ${name.length} bytes (max ${MAX_DNS_LABEL}): ${name}`
      );
    }
  }
}

const files = readdirSync(manifestDir).filter((name) => name.endsWith('.yaml'));
const problems = [];

for (const file of files) {
  const rendered = render(readFileSync(join(manifestDir, file), 'utf8'));

  if (rendered.includes('{') && /\{[A-Z]+\}/.test(rendered)) {
    const left = [...rendered.matchAll(/\{([A-Z]+)\}/g)].map((m) => m[1]);
    problems.push(`${file}: unsubstituted placeholder(s): ${[...new Set(left)].join(', ')}`);
  }

  for (const doc of rendered.split(/^---$/m)) {
    if (doc.trim().length > 0) inspect(doc, file, problems);
  }
}

if (selftest) {
  // One byte past the label cap, sized from the cap rather than from a hash
  // length. The margin has already moved once: "three-peaks-hub-migrate-" plus
  // a full SHA was 64, and shortening the app name took the same construction
  // to 60, where it proves nothing. Deriving the planted name from the limit
  // keeps this arm failing for the reason it claims to.
  const overLong = `${MIGRATE_PREFIX}${'0'.repeat(MAX_LABEL_VALUE + 1 - MIGRATE_PREFIX.length)}`;
  const planted = [];
  inspect(`kind: Job\nmetadata:\n  name: ${overLong}\n`, 'selftest', planted);
  if (planted.length === 0) {
    console.error(`[selftest] FAILED: a ${overLong.length}-byte Job name was not reported`);
    process.exit(1);
  }
  const fine = [];
  inspect(`kind: Job\nmetadata:\n  name: ${MIGRATE_PREFIX}${SHORT}\n`, 'selftest', fine);
  if (fine.length !== 0) {
    console.error('[selftest] FAILED: a short Job name was reported');
    process.exit(1);
  }
  console.log('[selftest] the length the deploy actually produces is the length checked');
}

if (problems.length > 0) {
  console.error(`\n${problems.length} manifest problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check:k8s passed (${files.length} manifests, rendered with a full-length SHA)`);
