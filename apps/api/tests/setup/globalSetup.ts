import { createHash } from 'node:crypto';
import pg from 'pg';
import { env } from '../../src/config/env.ts';
import {
  CHECKOUT_COMMENT_PREFIX,
  RESETTABLE_DATABASE,
  checkoutRoot,
  resolveTestDatabaseName,
} from './testDatabaseName.ts';

function maintenanceClient() {
  return new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.maintenanceDatabase,
  });
}

// A 64-bit key derived from the database name. Postgres advisory locks are
// per-database-cluster, so the key has to carry the name itself.
function runLockKey(database: string): bigint {
  return createHash('sha256').update(`three-peaks test run:${database}`).digest().readBigInt64BE(0);
}

let lockClient: pg.Client | null = null;

async function ensureTestDatabase(database: string): Promise<void> {
  const client = maintenanceClient();
  await client.connect();
  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [database]);
    if (exists.rowCount === 0) {
      // Identifiers cannot be parameterized; the name is derived and matched
      // against RESETTABLE_DATABASE above, never taken from input.
      await client.query(`create database "${database}"`);
    }
    // Stamps the checkout this database belongs to, so the pruner can tell a
    // live worktree's database from one whose checkout is gone.
    await client.query(
      `comment on database "${database}" is '${CHECKOUT_COMMENT_PREFIX}${checkoutRoot.replace(/'/g, "''")}'`
    );
  } finally {
    await client.end();
  }
}

async function acquireRunLock(database: string): Promise<void> {
  lockClient = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database,
  });
  await lockClient.connect();

  const key = runLockKey(database);
  const { rows } = await lockClient.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1) as locked',
    [key.toString()]
  );

  if (!rows[0]?.locked) {
    const { rows: holders } = await lockClient.query<{ pid: number; application_name: string }>(
      'select pid, application_name from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
      [database]
    );
    await lockClient.end();
    lockClient = null;
    throw new Error(
      `Another test run already holds ${database}.\n` +
        `Conflicting backends: ${holders.map((h) => h.pid).join(', ') || 'none visible'}\n` +
        'Run suites from separate worktrees to get them in parallel — a TRUNCATE landing ' +
        'under a live run deletes rows it has already created.'
    );
  }
}

export async function setup(): Promise<void> {
  if (env.environment !== 'test') {
    throw new Error(`Refusing to run tests with ENVIRONMENT=${env.environment}`);
  }

  const database = resolveTestDatabaseName();
  if (env.db.database !== database) {
    throw new Error(`DB_DATABASE is ${env.db.database}, expected the derived ${database}`);
  }
  if (!RESETTABLE_DATABASE.test(database)) {
    throw new Error(`Refusing to reset a database that is not a test database: ${database}`);
  }

  await ensureTestDatabase(database);
  await acquireRunLock(database);

  // Imported after the database exists: the module opens a pool on import.
  const { runMigrations } = await import('../../src/db/migrate.ts');
  await runMigrations();

  const { db } = await import('../../src/db/index.ts');
  const { sql } = await import('kysely');
  const tables = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'kysely\\_%'
  `.execute(db);

  if (tables.rows.length > 0) {
    const list = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
    await sql.raw(`truncate ${list} restart identity cascade`).execute(db);
  }
}

export async function teardown(): Promise<void> {
  if (lockClient) {
    await lockClient.query('select pg_advisory_unlock_all()').catch(() => {});
    await lockClient.end().catch(() => {});
    lockClient = null;
  }
  const { db } = await import('../../src/db/index.ts');
  await db.destroy().catch(() => {});
}
