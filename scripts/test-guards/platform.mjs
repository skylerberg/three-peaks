// The machinery under everything: transactions, validation, realtime, health, migrations.

export const guards = [
  {
    name: 'a mutation that fails rolls the whole request back',
    file: 'src/middleware/transaction.ts',
    // Without the rethrow, Hono's compose has already swallowed the error onto
    // c.error and Kysely sees a clean return -- so the partial write commits.
    find: '    if (c.error) throw c.error;',
    replace: '    if (false) throw c.error;',
    tests: ['tests/unit/transactionMiddleware.test.ts'],
    testName: 'rolls back a write when a later step in the same request throws',
  },
  {
    name: 'undeclared request fields are stripped, not stored',
    file: 'src/middleware/validators.ts',
    find: "  const stripped = schema.onDeepUndeclaredKey('delete');",
    replace: '  const stripped = schema;',
    tests: ['tests/unit/jsonValidator.test.ts'],
    testName: 'strips a key the schema does not declare',
  },
  {
    // The shallow form leaves a nested object untouched, and a settings blob is
    // stored as jsonb exactly as it survives validation.
    name: 'undeclared fields are stripped from a nested object too',
    file: 'src/middleware/validators.ts',
    find: "  const stripped = schema.onDeepUndeclaredKey('delete');",
    replace: "  const stripped = schema.onUndeclaredKey('delete');",
    tests: ['tests/e2e/models.test.ts'],
    testName: 'strips a field the schema does not declare',
  },
  {
    // Subscribing is not authorization; the per-event access check is. Without
    // it, naming any project id in a subscribe frame would deliver that
    // project's events to anyone.
    name: 'realtime delivery re-checks access for every event',
    file: 'src/services/realtime/transport.ts',
    find: '          if (allowed) connection.socket.send(message);',
    replace: '          void allowed; connection.socket.send(message);',
    tests: ['tests/e2e/realtime.test.ts'],
    testName: 'delivers nothing to someone who subscribed to a project they cannot read',
  },
  {
    name: 'nothing is published for a request that rolled back',
    file: 'src/services/realtime/index.ts',
    find: '  hooks.push(async () => {',
    replace: '  void hooks;\n  void (async () => {',
    tests: ['tests/unit/realtimeBus.test.ts'],
    testName: 'publishes nothing until the hook it queued is run',
  },
  {
    name: 'the projects list is asked for once per screen',
    file: 'src/lib/projects.svelte.ts',
    find: '    this.#attempt ??= this.#load();',
    replace: '    this.#attempt = this.#load();',
    tests: ['src/lib/projects.svelte.test.ts'],
    testName: 'asks the server once even when the screen asks again',
    runner: 'web',
  },
  {
    name: 'a reset forgets the attempt the previous account made',
    file: 'src/lib/projects.svelte.ts',
    find: '    this.loading = false;\n    this.#attempt = null;',
    replace: '    this.loading = false;',
    tests: ['src/lib/projects.svelte.test.ts'],
    testName: 'asks again for the next account after a reset',
    runner: 'web',
  },
  {
    name: 'a reconnected socket replays what it was watching',
    file: 'src/lib/realtime.svelte.ts',
    // The subscriptions live on the store rather than on the socket precisely
    // so a reconnect can replay them. Dropping the replay leaves a healthy
    // connection that delivers nothing.
    find: '      for (const projectId of this.#projects) {',
    replace: '      for (const projectId of []) {',
    tests: ['src/lib/realtime.svelte.test.ts'],
    testName: 're-subscribes to everything it was watching when it reconnects',
    runner: 'web',
  },
  {
    name: 'a socket closed for a dead credential is not reopened',
    file: 'src/lib/realtime.svelte.ts',
    find: "      if (action === 'revalidate') return;",
    replace: '      if (false) return;',
    tests: ['src/lib/realtime.svelte.test.ts'],
    testName: 'does not reconnect after the server says the credential is gone',
    runner: 'web',
  },
  {
    // A readiness probe that answers from memory alone puts a pod with no
    // database back into the load balancer's rotation.
    name: 'health reaches the database rather than answering ok regardless',
    file: 'src/routes/health.ts',
    find: "    await ping(c.get('db'));",
    replace: '',
    tests: ['tests/e2e/health.test.ts'],
    testName: 'reaches the database rather than answering from memory alone',
  },
  {
    name: 'a database missing a migration is reported as behind',
    file: 'src/db/migrate.ts',
    // The failure that matters is the quiet one: a check that always says the
    // database is current is indistinguishable from not having the check.
    find: '    .filter((migration) => migration.executedAt === undefined)',
    replace: '    .filter(() => false)',
    tests: ['tests/unit/pendingMigrations.test.ts'],
    testName: 'names a migration the database has never run',
  },
];
