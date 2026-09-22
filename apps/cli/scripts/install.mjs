// Puts `threepeaks` on the PATH and the agent skill where Claude Code finds it,
// both as symlinks into this checkout. A link rather than a copy or a global
// package install: the package depends on `workspace:*`, which nothing outside
// the workspace can resolve, and the launcher runs the TypeScript in place, so
// the command a person runs is always the source in front of them.
//
//   pnpm --filter @three-peaks/cli run install:global [--force]
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const force = process.argv.includes('--force');
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(packageDir, 'bin', 'threepeaks.mjs');
const skill = join(packageDir, 'skill');

async function link(target, path, what) {
  const existing = await lstat(path).catch(() => null);
  if (existing !== null) {
    const current = existing.isSymbolicLink() ? await readlink(path) : null;
    if (current === target) {
      console.log(`${what}: already linked at ${path}`);
      return;
    }
    // A real directory is somebody's work, and no flag here deletes that.
    if (!force || (existing.isDirectory() && current === null)) {
      console.error(
        `${what}: ${path} already exists${current === null ? '' : ` (-> ${current})`}` +
          (existing.isDirectory() && current === null
            ? '; move it aside first'
            : '; pass --force to replace it')
      );
      process.exitCode = 1;
      return;
    }
    await rm(path);
  }
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
  console.log(`${what}: ${path} -> ${target}`);
}

// A worktree is removed when its branch merges, and every link into it would
// dangle from then on.
if (packageDir.includes(`${sep}.worktrees${sep}`)) {
  console.warn(
    'Warning: this is a worktree. Run the install from the main checkout, or the links break when the worktree is removed.'
  );
}

let binDir;
try {
  binDir = execFileSync('pnpm', ['bin', '--global'], { encoding: 'utf8' }).trim();
} catch {
  console.error('Cannot find the pnpm global bin directory; run `pnpm setup` first.');
  process.exit(1);
}

await link(launcher, join(binDir, 'threepeaks'), 'command');
await link(skill, join(homedir(), '.claude', 'skills', 'threepeaks'), 'skill');

if (!(process.env.PATH ?? '').split(':').includes(binDir)) {
  console.warn(`Warning: ${binDir} is not on PATH.`);
}
console.log('Shell completion: threepeaks completion --help');
