// Copies every tracked `.env*.example` to the real filename when it is absent.
//
// It exists because `node --env-file=X` hard-errors when X is missing — the
// same fact CI works around with a heredoc. Every fresh clone and every new
// worktree hits it on the first `pnpm dev`, and one idempotent command beats a
// README paragraph.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// apps/canva is here because AGENTS.md sends every checkout and every worktree
// through this command, and `canva apps start` reads .env for its port and for
// the API host. Without it the app serves on Canva's default 8080 and posts to
// 3001 -- the port this repo's API container is pinned to in production, and
// the collision the 173xx block exists to avoid.
const dirs = ['apps/api', 'apps/canva'];

// Homebrew's initdb makes the superuser the login name and creates no
// `postgres` role at all, so the example's value is the one thing in it that
// cannot work on the Mac this is developed on: every checkout and every
// worktree met `role "postgres" does not exist` and edited two files by hand.
// The example still says `postgres`, because that is what a Linux distribution
// or a container gives you, and the deploy reads none of this.
function localize(contents) {
  if (process.platform !== 'darwin') return contents;
  return contents.replace(/^DB_USER=postgres$/gm, `DB_USER=${userInfo().username}`);
}

let copied = 0;
for (const dir of dirs) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.example')) continue;
    const target = join(abs, name.slice(0, -'.example'.length));
    if (existsSync(target)) continue;
    writeFileSync(target, localize(readFileSync(join(abs, name), 'utf8')));
    console.log(`created ${dir}/${name.slice(0, -'.example'.length)}`);
    copied += 1;
  }
}
console.log(copied === 0 ? 'env files already present' : `${copied} env file(s) created`);

// An existing .env is never rewritten -- it holds secrets and local choices, and
// this command is run casually. But a file written before the ports moved pins
// the old ones, and the symptom is the collision the move was meant to end, so
// say which lines are stale rather than leaving them to be discovered.
const STALE = [
  [/^PORT=3001$/m, 'PORT=17310'],
  [/^CORS_ORIGINS=http:\/\/localhost:5173$/m, 'CORS_ORIGINS=http://localhost:17300'],
  [/^APP_URL_BASE=http:\/\/localhost:5173$/m, 'APP_URL_BASE=http://localhost:17300'],
];

for (const dir of dirs) {
  const target = join(root, dir, '.env');
  if (!existsSync(target)) continue;
  const contents = readFileSync(target, 'utf8');
  const stale = STALE.filter(([pattern]) => pattern.test(contents));
  if (stale.length === 0) continue;
  console.warn(
    `\n${dir}/.env still names the old development ports. Nothing here rewrites it; ` +
      'change these lines by hand:'
  );
  for (const [pattern, replacement] of stale) {
    console.warn(`  ${pattern.source.replace(/[$^]|\\/g, '')}  ->  ${replacement}`);
  }
}
