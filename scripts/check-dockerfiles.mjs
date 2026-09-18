// Verifies two things about what a Dockerfile COPYs from the build context:
// that it survives .dockerignore, and that the deploy workflow's path filter for
// that image covers it.
//
// The first exists because that mismatch is invisible locally: the API image
// copies the other workspace packages' manifests -- pnpm reads the whole
// workspace to validate the lockfile even for a filtered install -- and
// excluding those directories made the build fail on a line that reads
// perfectly well. Nothing short of an actual image build could see it, so CI was
// the first to know.
//
// The second is the quieter one. A filter narrower than its image skips a deploy
// that mattered, and the push goes green: production keeps serving the previous
// release and nothing anywhere reports a failure. Both lists are hand-written
// and neither is derived from the other, so this reads one against the other.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const selftest = process.argv.includes('--selftest');

const DOCKERFILES = ['apps/api/Dockerfile', 'apps/preview-edge/Dockerfile'];

const WORKFLOW = '.github/workflows/deploy.yaml';

// Which filter in that workflow is answerable for each image. The `web` filter
// is absent because the SPA has no image: it is built from the checkout, so
// there is no COPY set to read it against.
const FILTER_FOR = {
  'apps/api/Dockerfile': 'api',
  'apps/preview-edge/Dockerfile': 'preview_edge',
};

// `filters:` is a block scalar, so its body is literal text rather than
// structure the workflow parser resolves. Reading it by indentation keeps this
// dependency-free; a YAML parser would be the larger change, not the smaller.
function parseFilters() {
  const lines = readFileSync(join(root, WORKFLOW), 'utf8').split('\n');
  const filters = {};
  let indent = null;
  let current = null;

  for (const line of lines) {
    if (indent === null) {
      const start = /^(\s*)filters:\s*\|/.exec(line);
      if (start) indent = start[1].length;
      continue;
    }
    if (line.trim().length === 0) continue;
    // Dedenting to the `filters:` key or past it ends the block scalar.
    if (line.search(/\S/) <= indent) break;

    const name = /^\s+([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (name) {
      current = name[1];
      filters[current] = [];
      continue;
    }
    const item = /^\s+-\s*'([^']+)'\s*$/.exec(line);
    if (item && current) filters[current].push(item[1]);
  }
  return filters;
}

function parseIgnore() {
  const path = join(root, '.dockerignore');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// Docker's matcher is Go's filepath.Match extended with a double-star. This
// covers the forms this repo actually uses; it errs toward reporting a match,
// because a false "excluded" fails loudly here rather than silently in a build.
function matchesPattern(pattern, path) {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;

  const source = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, 'DOUBLESTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/DOUBLESTAR/g, '.*');

  return { hit: new RegExp(`^${source}(/.*)?$`).test(path), negated };
}

function isExcluded(path, patterns) {
  let excluded = false;
  for (const pattern of patterns) {
    const { hit, negated } = matchesPattern(pattern, path);
    if (hit) excluded = !negated;
  }
  return excluded;
}

// Conventional exclusions that are meant to apply inside a copied directory.
// Anything else nested under one is almost certainly a mistake: the COPY still
// succeeds and silently omits the excluded part, which is how the preview-edge
// image once shipped with no source in it.
const EXPECTED_NESTED =
  /(^|\/)(node_modules|dist|coverage|data|\.env.*|.*\.tsbuildinfo|.*\.md|openapi\.json|realtime-events\.json|tests)$/;

function nestedExclusions(copiedDir, patterns) {
  const prefix = copiedDir.endsWith('/') ? copiedDir : `${copiedDir}/`;
  return patterns.filter(
    (pattern) =>
      !pattern.startsWith('!') &&
      !pattern.startsWith('**') &&
      pattern.startsWith(prefix) &&
      !EXPECTED_NESTED.test(pattern)
  );
}

// Deliberately not `matchesPattern`: that one appends an implicit "and anything
// beneath", which is right for an exclusion and wrong here -- a pattern that
// matched more than it says would report a gap as covered, which is the one
// answer this check must never give.
function globMatches(glob, path) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, 'DOUBLESTAR')
    .replace(/\*/g, '[^/]*')
    .replace(/DOUBLESTAR/g, '.*');
  return new RegExp(`^${source}$`).test(path);
}

// A COPY of a directory is only covered by a glob that takes the whole of it.
// One naming part of it -- `apps/api/src/**` against `COPY apps/api` -- leaves
// the rest of the directory able to change without deploying, so it is a gap.
function covers(glob, source) {
  return globMatches(glob, source) || glob === `${source}/**`;
}

function filterGaps(dockerfile, globs, patterns) {
  const gaps = [];
  for (const source of copySources(dockerfile)) {
    if (!existsSync(join(root, source))) continue;
    if (isExcluded(source, patterns)) continue;
    if (globs.some((glob) => covers(glob, source))) continue;
    gaps.push(
      `${WORKFLOW}: the ${FILTER_FOR[dockerfile]} filter does not cover ` +
        `${dockerfile}'s COPY ${source} -- a change to it would deploy nothing`
    );
  }
  return gaps;
}

function copySources(dockerfile) {
  const source = readFileSync(join(root, dockerfile), 'utf8');
  const sources = [];

  for (const line of source.split('\n')) {
    const match = /^\s*COPY\s+(.*)$/i.exec(line);
    if (!match) continue;
    // --from=<stage> copies come from an earlier build stage, not the context.
    if (/--from=/.test(line)) continue;

    const parts = match[1].split(/\s+/).filter((part) => !part.startsWith('--'));
    // The last argument is the destination inside the image.
    for (const part of parts.slice(0, -1)) sources.push(part);
  }
  return sources;
}

const patterns = parseIgnore();
const filters = parseFilters();
const problems = [];

// A filters block this failed to read would leave every image reported as
// covered, which is the vacuous pass this check exists to rule out.
for (const [dockerfile, name] of Object.entries(FILTER_FOR)) {
  const globs = filters[name];
  if (!globs || globs.length === 0) {
    problems.push(`${WORKFLOW}: no ${name} filter found, so ${dockerfile} is unchecked`);
    continue;
  }
  problems.push(...filterGaps(dockerfile, globs, patterns));
}

for (const dockerfile of DOCKERFILES) {
  for (const source of copySources(dockerfile)) {
    if (!existsSync(join(root, source))) {
      problems.push(`${dockerfile}: COPY ${source} -- no such path in the repository`);
      continue;
    }
    if (isExcluded(source, patterns)) {
      problems.push(`${dockerfile}: COPY ${source} -- excluded by .dockerignore`);
      continue;
    }

    // A directory copy that succeeds while silently missing part of its
    // contents is worse than one that fails outright.
    for (const nested of nestedExclusions(source, patterns)) {
      problems.push(
        `${dockerfile}: COPY ${source} -- .dockerignore excludes ${nested} from inside it`
      );
    }
  }
}

if (selftest) {
  // Sensitivity: the matcher has to separate the two cases, or this check
  // passes by never matching anything.
  if (!isExcluded('apps/api/tests', patterns)) {
    console.error('[selftest] FAILED: an excluded path was not detected as excluded');
    process.exit(1);
  }
  if (isExcluded('apps/api/package.json', patterns)) {
    console.error('[selftest] FAILED: an included path was reported as excluded');
    process.exit(1);
  }
  if (nestedExclusions('apps/api', ['apps/api/src']).length !== 1) {
    console.error('[selftest] FAILED: an unexpected nested exclusion was not reported');
    process.exit(1);
  }
  if (nestedExclusions('apps/api', ['apps/api/node_modules']).length !== 0) {
    console.error('[selftest] FAILED: a conventional nested exclusion was reported');
    process.exit(1);
  }

  // The same pair for the filter half. Sensitivity first: with the glob that
  // carries packages/shared taken out, the API's COPY of it has to be reported.
  const gapped = filters.api.filter((glob) => glob !== 'packages/shared/**');
  const seen = filterGaps('apps/api/Dockerfile', gapped, patterns);
  if (!seen.some((gap) => gap.includes('packages/shared'))) {
    console.error('[selftest] FAILED: a filter missing a COPYed path was reported as covering it');
    process.exit(1);
  }
  // Specificity: the lists as written report nothing, or the arm above proves
  // only that this check fails on everything.
  for (const [dockerfile, name] of Object.entries(FILTER_FOR)) {
    if (filterGaps(dockerfile, filters[name], patterns).length > 0) {
      console.error(`[selftest] FAILED: the ${name} filter was reported as leaving a gap`);
      process.exit(1);
    }
  }
  if (covers('apps/api/src/**', 'apps/api')) {
    console.error(
      '[selftest] FAILED: a glob covering part of a directory was accepted for all of it'
    );
    process.exit(1);
  }

  console.log('[selftest] the matcher separates excluded paths from included ones,');
  console.log('[selftest] an unexpected nested exclusion from a conventional one,');
  console.log('[selftest] and a filter that covers its image from one that leaves a gap');
}

if (problems.length > 0) {
  console.error(`\n${problems.length} Dockerfile/.dockerignore/deploy-filter conflict(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `check:dockerfiles passed (${DOCKERFILES.length} Dockerfiles, ` +
    `${Object.keys(FILTER_FOR).length} deploy filters)`
);
