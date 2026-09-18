// Signing in, sessions, access checks, and the Canva app -- the pairing that
// mints a session, and the record of which bundle is serving it.

export const guards = [
  {
    // The whole of what binds a Canva token to OUR app. Every app on Canva gets
    // tokens signed by the same JWKS, so dropping the audience leaves a check
    // that still verifies a real signature and still reads a real user id --
    // and accepts a token minted for somebody else's app.
    name: 'a Canva token issued to another app is refused',
    file: 'src/services/canvaApp.ts',
    find: '      audience: appId,\n',
    replace: '',
    tests: ['tests/e2e/canvaApp.test.ts'],
    testName: 'refuses one issued to another app',
  },
  {
    // Expiry and reuse answering differently from a code nobody issued turns
    // eight characters of a small alphabet into an oracle worth grinding.
    name: 'a spent pairing code is not distinguishable from an invented one',
    file: 'src/services/canvaApp.ts',
    find: "    .where('canva_app_pairing.claimed_at', 'is', null)\n",
    replace: '',
    tests: ['tests/e2e/canvaApp.test.ts'],
    testName: 'refuses a second spend of one code',
  },
  {
    name: 'a caller with no access gets 404, not 403',
    file: 'src/services/authorization.ts',
    // The classic mistake: refusing with the "honest" status, which tells an
    // outsider the project exists.
    find: "    throw new AppError(404, 'Project not found');\n  }\n\n  return { projectId, role: normalizeProjectRole(row.role), isCreator: false };",
    replace:
      "    throw new AppError(403, 'Project not found');\n  }\n\n  return { projectId, role: normalizeProjectRole(row.role), isCreator: false };",
    tests: ['tests/e2e/authorization.test.ts'],
    testName: 'sees 404, not 403, when reading',
  },
  {
    name: 'project roles normalize fail-closed',
    file: 'packages/shared/src/roles.ts',
    root: true,
    find: "  return role === 'editor' ? 'editor' : 'viewer';",
    replace: "  return (role ?? 'viewer') as ProjectRole;",
    tests: ['src/roles.test.ts'],
    testName: 'reads',
    runner: 'shared',
  },
  {
    name: 'a viewer cannot write',
    file: 'src/services/authorization.ts',
    find: "  if (access.role !== 'editor') {",
    replace: '  if (false) {',
    tests: ['tests/e2e/authorization.test.ts'],
    testName: 'is refused writes with 403',
  },
  {
    name: 'a reset link cannot be spent twice',
    file: 'src/routes/auth.ts',
    find: "        alternative_id: newId(),\n        updated_at: new Date(),\n      })\n      .where('app_user.id', '=', claims.sub)",
    replace:
      "        updated_at: new Date(),\n      })\n      .where('app_user.id', '=', claims.sub)",
    tests: ['tests/e2e/auth.test.ts'],
    testName: 'mails a link that sets a new password exactly once',
  },
  {
    name: 'one token family cannot be spent as another',
    file: 'src/services/signedToken.ts',
    find: '  if (parsed[TYPE_CLAIM] !== tokenType) return null;',
    replace: '  if (false) return null;',
    tests: ['tests/unit/signedToken.test.ts'],
    testName: 'refuses a token of one family presented as another',
  },
  {
    // The dummy-password verify beside this line closes a timing oracle, and no
    // test can observe timing -- a guard aimed at that line would report
    // STILL-PASSED forever. What a test CAN observe is that both answers are
    // byte-identical, so that is what this breaks.
    name: 'an unknown email and a wrong password give the same answer',
    file: 'src/routes/auth.ts',
    find: "      throw new AppError(401, 'Invalid email or password');\n    }\n\n    if (!(await verifyPassword(row.password_hash, password))) {",
    replace:
      "      throw new AppError(401, 'No account with that email');\n    }\n\n    if (!(await verifyPassword(row.password_hash, password))) {",
    tests: ['tests/e2e/auth.test.ts'],
    testName: 'answers 401 identically for an unknown address',
  },
  {
    name: 'a signed-out visitor is sent to login',
    file: 'src/lib/session.svelte.ts',
    find: "    if (this.status === 'anon' && !isPublic) {",
    replace: '    if (false) {',
    tests: ['src/lib/guard.svelte.test.ts'],
    testName: 'sends a signed-out visitor to login',
    runner: 'web',
  },
  {
    name: 'no screen is mounted before the first-load guard has run',
    file: 'src/App.svelte',
    // Reading the status directly reopens the window the flag exists to close:
    // init() leaves `unknown` a microtask before the guard redirects, and a
    // screen mounted in between fetches with the token init has just cleared.
    find: '    {#if !booted}',
    replace: "    {#if session.status === 'unknown'}",
    tests: ['src/boot.svelte.test.ts'],
    testName: 'does not fetch with a token the session has just cleared',
    runner: 'web',
  },
  {
    // When a build went live and when it was last used are different questions,
    // and only the insert can answer the first. Carrying first_seen_at into the
    // update makes every row say it appeared the last time somebody opened the
    // app -- so the record would show a bundle that has been up there for weeks
    // as having arrived minutes ago, which is the one thing a person reads it
    // to find out.
    name: 'a build keeps the moment it was first seen',
    file: 'src/services/canvaApp.ts',
    find: "      conflict.column('commit').doUpdateSet({\n        branch: report.branch,",
    replace:
      "      conflict.column('commit').doUpdateSet({\n        first_seen_at: seenAt,\n        branch: report.branch,",
    tests: ['tests/e2e/canvaApp.test.ts'],
    testName: 'keeps when a build first appeared while moving when it was last seen',
  },
];
