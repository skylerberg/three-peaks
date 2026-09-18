import { execFileSync } from 'node:child_process';
import { defineConfig } from '@canva/app-scripts';

// Tells the bundle what it is, the way BACKEND_HOST is already told to it.
//
// The bundle is uploaded into the Developer Portal by hand and no Canva API
// reads it back, so a build that cannot name itself can only be identified by
// comparing timestamps and guessing. A define is the whole of the channel: a
// browser bundle has no environment to read at runtime, and a file written into
// src before each build would be a source tree the build mutates.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const build = {
  commit: git(['rev-parse', '--short=12', 'HEAD']) || 'unknown',
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
  // A bundle built from a tree with uncommitted changes is not the commit it
  // names, and the portal will go on serving it long after the tree has moved.
  dirty: git(['status', '--porcelain']) !== '',
  built_at: new Date().toISOString(),
};

export default defineConfig({
  config: (rsbuildConfig) => {
    rsbuildConfig.source = {
      ...rsbuildConfig.source,
      define: { ...rsbuildConfig.source?.define, APP_BUILD: JSON.stringify(build) },
    };
    return rsbuildConfig;
  },
});
