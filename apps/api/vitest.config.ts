import { defineConfig } from 'vitest/config';
import { guardMutation } from '../../scripts/guard-mutation.mjs';
import { baseDatabaseName, resolveTestDatabaseName } from './tests/setup/testDatabaseName.ts';

// Set before the workers fork, so every one of them inherits the derived name
// rather than recomputing it against a different cwd.
const base = baseDatabaseName();
process.env.TEST_DB_BASE = base;
const database = resolveTestDatabaseName();
process.env.DB_DATABASE = database;
process.env.DB_POOL_MAX ??= '5';

// The live tree interactively; a verbose per-test stream when output goes to a
// file or a CI log, so a long run is followable and a stall is visible.
const reporters = process.stdout.isTTY ? ['default'] : ['verbose'];

export default defineConfig({
  // Applies a mutation-guard edit in memory when GUARD_MUTATION is set.
  // Inactive otherwise.
  plugins: [guardMutation()],
  cacheDir: process.env.GUARD_CACHE_DIR,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters,
    pool: 'forks',
    // Files in one run share a database, so they cannot run concurrently. CI
    // gets its parallelism by sharding, each shard with its own Postgres.
    fileParallelism: false,
    env: { TEST_DB_BASE: base, DB_DATABASE: database, DB_POOL_MAX: process.env.DB_POOL_MAX },
    // The CLI's tests run here rather than in a suite of its own: its e2e tests
    // drive this app in-process against this database, and a second runner
    // would contend for the same advisory lock. Vitest exits 0 on an include
    // that matches nothing, so after touching this, count the collected files.
    include: [
      'tests/unit/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'src/**/*.test.ts',
      '../cli/tests/**/*.test.ts',
    ],
    globalSetup: ['./tests/setup/globalSetup.ts'],
    setupFiles: ['./tests/setup/assertTestDatabase.ts', './tests/setup/resetProcessState.ts'],
  },
});
