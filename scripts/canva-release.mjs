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

console.log(`Building apps/canva against ${host}\n`);
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

console.log(`\n  ok   ${relativeBundle} is ${(built.size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  ok   it names ${host}, and no localhost`);

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
`);

if (!configPushed) process.exit(1);
