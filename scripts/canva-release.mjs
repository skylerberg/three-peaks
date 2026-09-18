// Builds the Canva app for production, pushes its config, and says exactly what
// is left to do by hand.
//
// The upload is the part that cannot be scripted: no Canva CLI command sends
// app.js anywhere and the Connect API is design content rather than app
// management, so the bundle goes into the portal's App source field by hand.
// Everything either side of that is here, and the check on the built file is
// what earns the script its keep -- `build` and `build:prod` differ by one
// environment variable, the portal accepts either without comment, and a bundle
// naming localhost fails for the first person to open the app rather than for
// whoever uploaded it.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const canvaEnv = join(root, 'apps/canva/.env');
const canvaExample = join(root, 'apps/canva/.env.example');
const apiEnv = join(root, 'apps/api/.env');
const bundle = join(root, 'apps/canva/dist/app.js');
const portal = 'https://www.canva.com/developers/app';

const FLAGS = ['--skip-config', '--no-open'];
const unknown = process.argv.slice(2).filter((arg) => !FLAGS.includes(arg));
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown.join(' ')}`);
  console.error(`usage: pnpm canva:release [${FLAGS.join('] [')}]`);
  process.exit(1);
}

const skipConfig = process.argv.includes('--skip-config');
const canOpen =
  !process.argv.includes('--no-open') && process.platform === 'darwin' && process.stdout.isTTY;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function envValue(file, key) {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

// The CLI reads the id from apps/canva/.env alone: an id in the environment it
// is spawned with does not reach it, and it answers a missing one with "correct
// your app's setup. Run canva apps doctor", which diagnoses everything but this.
function appId() {
  const own = envValue(canvaEnv, 'CANVA_APP_ID');
  if (own) return own;

  // The example names the id, so a .env without one was copied from an earlier
  // version of it -- setup:env writes that file once and never revisits it.
  const fromExample = envValue(canvaExample, 'CANVA_APP_ID');
  const known = envValue(apiEnv, 'CANVA_APP_ID') ?? fromExample;
  const stale = fromExample ? ` The example carries one, so this file predates it.` : '';
  const line = known
    ? `The id is checked in, so the line to add is:\n\n` +
      `    echo 'CANVA_APP_ID=${known}' >> apps/canva/.env`
    : `Copy it from ${portal}s and add it:\n\n` + `    echo 'CANVA_APP_ID=<id>' >> apps/canva/.env`;

  fail(
    `apps/canva/.env has no CANVA_APP_ID, and the Canva CLI reads the id from that\n` +
      `file and nowhere else.${stale}\n\n${line}\n\n` +
      `Or pick the app from a list, which writes the same line:\n\n` +
      `    pnpm --filter @three-peaks/canva exec canva apps link`
  );
}

// The commit the bundle will carry, computed the way canva-app.config.ts
// computes it. A second copy, but a checked one: the build below fails unless
// the bundle it produced actually contains this string, so the two cannot
// disagree quietly.
function builtCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitOrNull(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function since(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return 'at an unknown time';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// How far the deployed commit is behind what this checkout could ship. Silent
// where the commit is one this clone has never fetched, which is what a bundle
// built on another machine arrives as.
function behindMain(commit) {
  if (gitOrNull(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]) === null) return null;
  const base = gitOrNull(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  if (base === null) return null;
  const count = gitOrNull(['rev-list', '--count', `${commit}..origin/main`]);
  return count === null ? null : Number(count);
}

// What the portal is serving, according to the bundles that have run. Canva
// exposes no API for the App source field, so the API's record of what reported
// itself is the only evidence there is -- and being unable to reach it says
// nothing about the release, so it never stops one.
async function reportDeployed(host) {
  let response;
  try {
    response = await fetch(`${host}/api/canva-app/build`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.log(`  --   could not ask ${host} what it is serving (${error.message})`);
    return;
  }

  if (response.status === 404) {
    console.log('  --   nothing has reported a build. Either the release that records');
    console.log('       them is not deployed yet, the bundle up there predates it, or');
    console.log('       nobody has opened the app since');
    return;
  }
  // Auth is global there and this route opts out, so a 401 is the deployed API
  // not having the route at all rather than anything about a credential.
  if (response.status === 401) {
    console.log(`  --   ${host} does not serve this route yet, so the release that`);
    console.log('       records builds has not gone out');
    return;
  }
  if (!response.ok) {
    console.log(`  --   ${host} answered ${response.status} for the deployed build`);
    return;
  }

  const build = await response.json();
  const behind = behindMain(build.commit);
  const distance =
    behind === null ? '' : behind === 0 ? '  (current)' : `  (${behind} behind main)`;
  console.log(
    `  now  the portal is serving ${build.commit}${build.dirty ? ' (dirty)' : ''}${distance}`
  );
  console.log(`       on ${build.branch}, last seen ${since(build.last_seen_at)}`);
}

// Read off build:prod rather than kept as a second copy that is free to
// disagree with the build this script just ran.
function productionHost() {
  const manifest = JSON.parse(readFileSync(join(root, 'apps/canva/package.json'), 'utf8'));
  const found = [...(manifest.scripts?.['build:prod'] ?? '').matchAll(/CANVA_BACKEND_HOST=(\S+)/g)];
  if (found.length !== 1) {
    fail(
      `apps/canva's build:prod names ${found.length} backend hosts, and this script reads\n` +
        `the production one off it. Name exactly one there, or teach this script where\n` +
        `else to look.`
    );
  }
  return found[0][1];
}

function run(args) {
  return (
    spawnSync('pnpm', ['--filter', '@three-peaks/canva', ...args], {
      cwd: root,
      stdio: 'inherit',
    }).status === 0
  );
}

function attempt(action) {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}

const id = appId();
const host = productionHost();
const pushCommand = 'pnpm --filter @three-peaks/canva exec canva apps config push --strategy local';

const commit = builtCommit();
if (commit === 'unknown') {
  fail(
    `git could not name a commit for this checkout, so the bundle would carry no\n` +
      `build anybody could recognise -- and the portal keeps whatever is uploaded\n` +
      `until it is replaced by hand. Release from a git checkout.`
  );
}

console.log('Before this release:\n');
await reportDeployed(host);

console.log(`\nBuilding apps/canva against ${host}\n`);
const startedAt = Date.now() - 1000;
if (!run(['run', 'build:prod'])) {
  fail('the build failed. Nothing was pushed, and there is nothing to upload.');
}

const relativeBundle = relative(root, bundle);
if (!existsSync(bundle)) fail(`the build left no ${relativeBundle}.`);

const built = statSync(bundle);
if (built.mtimeMs < startedAt) {
  fail(`${relativeBundle} predates this build, so the build wrote nothing. Do not upload it.`);
}

const source = readFileSync(bundle, 'utf8');
if (source.includes('localhost')) {
  fail(
    `${relativeBundle} names localhost, so something in it carries a development\n` +
      `host.\n\n` +
      `That bundle uploads, installs and opens exactly like a good one, and then\n` +
      `reaches an API on the user's own machine. Check what build:prod sets\n` +
      `CANVA_BACKEND_HOST to, and that nothing under apps/canva/src names a host of\n` +
      `its own -- BACKEND_HOST is the only one the build substitutes.`
  );
}
if (!source.includes(host)) {
  fail(
    `${relativeBundle} does not name ${host}, so it is not pointed at\n` +
      `production. Check that BACKEND_HOST still reaches the built file.`
  );
}

if (!source.includes(commit)) {
  fail(
    `${relativeBundle} does not carry ${commit}, so it cannot report which build it\n` +
      `is and the portal's copy will stay unidentifiable. Check that\n` +
      `apps/canva/canva-app.config.ts still defines APP_BUILD.`
  );
}

console.log(`\n  ok   ${relativeBundle} is ${(built.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  ok   it names ${host}, and no localhost`);
console.log(`  ok   it reports itself as ${commit}`);

let configPushed = true;
if (skipConfig) {
  console.log('  --   canva-app.json not pushed (--skip-config)');
} else {
  console.log('\nPushing canva-app.json to the Developer Portal\n');
  // The id is not passed along: `config push` documents an appId positional and
  // its parser rejects one (CLI 2.9.0). It reads apps/canva/.env instead, which
  // is what appId() above insists on.
  configPushed = run(['exec', 'canva', 'apps', 'config', 'push', '--strategy', 'local']);
  console.log(
    configPushed
      ? "\n  ok   the portal has this checkout's permissions and intents"
      : '\n  FAILED to push canva-app.json (above). The bundle below is still good to\n' +
          '       upload; the portal simply keeps the permissions and intents it had.\n\n' +
          '       An expired login is the usual cause:\n\n' +
          '           pnpm --filter @three-peaks/canva exec canva login\n' +
          `           ${pushCommand}`
  );
}

const url = `${portal}/${id}`;
const opened = { clipboard: false, finder: false, browser: false };
if (canOpen) {
  opened.clipboard = attempt(() => execFileSync('pbcopy', { input: bundle }));
  opened.finder = attempt(() => execFileSync('open', ['-R', bundle]));
  opened.browser = attempt(() => execFileSync('open', [url]));
}

const hint = [
  opened.clipboard && 'the path is on your clipboard',
  opened.finder && 'Finder has the file selected',
]
  .filter(Boolean)
  .join(', ');

console.log(`
Canva has no API for the bundle, so the upload itself is yours to do:

  1. ${opened.browser ? 'The Developer Portal is open in your browser at' : 'Open the Developer Portal at'}
       ${url}
  2. Under "App source", set "JavaScript file" to
       ${bundle}${hint ? `\n     -- ${hint}.` : ''}
  3. Press "Save". Nobody has the new bundle until that lands: an installed app
     is loaded from the portal's copy, not from this checkout.
  4. Open it in a real design to check it before telling anyone:
       pnpm --filter @three-peaks/canva exec canva apps preview
  5. Opening it is what makes it report, so run this again afterwards: it
     should say the portal is serving ${commit}.
`);

if (!configPushed) process.exit(1);
