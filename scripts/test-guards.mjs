// Mutation testing. Each entry names a bug and the exact edit that puts it
// back; the runner requires the named tests to FAIL with that edit in place.
//
// This exists because a unit test can measure nothing and still report green --
// a stale expectation, a fixture that stopped reaching the code path, an
// assertion that was already true before the fix. A guard whose tests still
// pass has stopped guarding anything, and nothing else in the repo can tell you
// that.
//
// Rules for adding one:
//   * `find` must match EXACTLY ONCE in the file. A pattern that matches
//     nothing leaves the source correct and the tests green, which is
//     indistinguishable from a guard that works.
//   * `testName` should be narrow enough that exactly one case fails. A widened
//     name can turn a five-second failure into a run with no upper bound.
//   * The bug should be one a reviewer would plausibly introduce, not a
//     syntactic nonsense that fails to compile.

export const guards = [
  {
    // Measured against Canva: the export dialog lets a person pick a subset of
    // pages, and an ExportBlob is a bare `{ url }` with nothing in it saying
    // which page it holds. Without this check two blobs line up against the
    // first two of 47 pages by position -- the wrong artwork on those cards,
    // and the other 45 tombstoned -- and every step of it looks normal.
    name: 'an export missing pages is refused before a run opens',
    runner: 'canva',
    file: 'src/design.ts',
    find: '  if (result.exportBlobs.length !== pageCount) {',
    replace: '  if (false) {',
    tests: ['src/design.test.ts'],
    testName: 'refuses an export holding fewer pages than the design',
  },
  {
    // The whole of what binds a Canva token to OUR app. Every app on Canva gets
    // tokens signed by the same JWKS, so dropping the audience leaves a check
    // that still verifies a real signature and still reads a real user id --
    // and accepts a token minted for somebody else's app.
    name: 'a Canva token issued to another app is refused',
    package: 'api',
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
    package: 'api',
    file: 'src/services/canvaApp.ts',
    find: "    .where('canva_app_pairing.claimed_at', 'is', null)\n",
    replace: '',
    tests: ['tests/e2e/canvaApp.test.ts'],
    testName: 'refuses a second spend of one code',
  },
  {
    // The tiers exist in an order, and the order is the design: an id settles a
    // page before a title does. Running the title tier first is a one-line
    // reordering that reads as harmless and quietly hands each card to whatever
    // page happens to share its name.
    name: 'a page id outranks a title, never the other way round',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find:
      '  for (const [index, page] of pages.entries()) {\n' +
      "    claim(index, byPageId.get(page.pageId), 'page_id');\n" +
      '  }\n\n' +
      '  for (const [index, key] of keys.entries()) {\n' +
      "    claim(index, byIdentity.get(key), 'identity');\n" +
      '  }',
    replace:
      '  for (const [index, key] of keys.entries()) {\n' +
      "    claim(index, byIdentity.get(key), 'identity');\n" +
      '  }\n\n' +
      '  for (const [index, page] of pages.entries()) {\n' +
      "    claim(index, byPageId.get(page.pageId), 'page_id');\n" +
      '  }',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'lets a page id outrank a title another page holds',
  },
  {
    // A deck reads in the order its design does, and every screen downstream
    // draws that order -- the explorer, the sheets, the Blender table. Dropping
    // the call leaves every card imported, versioned and named exactly right,
    // in whatever order the pages happened to arrive in and the deck happened
    // to already hold. Nothing else in the run says a word about it.
    name: 'a finished import leaves the deck in the design\u2019s order',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find: '  await orderDeckToExport(c, access);\n',
    replace: '',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'follows the design when its pages are moved around',
  },
  {
    name: 'a caller with no access gets 404, not 403',
    package: 'api',
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
    // homeColumns writes all four columns every time, and the CHECK 0010 added
    // is what turns a partial write into a refusal rather than a row that is in
    // two places. Leaving the old folder behind is the way to write one.
    name: 'a file arriving in a deck leaves its folder behind',
    package: 'api',
    file: 'src/services/fileHome.ts',
    find:
      '      return { folder_id: null, deck_id: home.deckId, ' +
      'component_id: null, component_role: null };',
    replace:
      '      return { deck_id: home.deckId, component_id: null, component_role: null } as HomeColumns;',
    tests: ['tests/e2e/fileHomes.test.ts'],
    testName: 'leaves the folder behind when a file moves out of Assets into a deck',
  },
  {
    // The whole of what makes Assets the owner-less case. Dropping it puts every
    // card of every deck back in the explorer, which is the duplication the
    // sections exist to remove -- and it reads as a harmless filter to delete.
    name: 'Assets lists nothing a deck or a component holds',
    package: 'api',
    file: 'src/routes/files.ts',
    find: "        .where('file.deleted_at', 'is', null)\n        .where(unowned)",
    replace: "        .where('file.deleted_at', 'is', null)",
    tests: ['tests/e2e/components.test.ts'],
    testName: 'keeps its artwork out of the Assets listing',
  },
  {
    // Leaving an image the deck owns out of its card list would strand it: in
    // the deck, and in no list any screen draws. The other half of the same
    // rule -- refusing a file the deck does not own -- has a test of its own.
    name: 'a deck may not be left holding artwork with no place in it',
    package: 'api',
    file: 'src/services/decks.ts',
    find: '  if (stranded.length > 0) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'refuses a list that leaves one of the deck’s own images out',
  },
  {
    // A tombstone above a row is not a tombstone on it. Marking the cards would
    // make a restore resurrect artwork somebody deleted one card at a time,
    // which is exactly what the folder rule already refuses to do.
    name: 'a deck’s tombstone is never copied onto its cards',
    package: 'api',
    file: 'src/routes/decks.ts',
    find: "      const marked = await db\n        .updateTable('deck')",
    replace:
      "      await db\n        .updateTable('file')\n        .set({ deleted_at: new Date() })\n" +
      "        .where('file.deck_id', '=', deckId)\n        .execute();\n" +
      "      const marked = await db\n        .updateTable('deck')",
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'tombstones it and keeps its artwork',
  },
  {
    name: 'project roles normalize fail-closed',
    package: 'api',
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
    package: 'api',
    file: 'src/services/authorization.ts',
    find: "  if (access.role !== 'editor') {",
    replace: '  if (false) {',
    tests: ['tests/e2e/authorization.test.ts'],
    testName: 'is refused writes with 403',
  },
  {
    name: 'the upload content type comes from magic bytes, not the client',
    package: 'api',
    file: 'src/services/files.ts',
    find: "    contentType: sniffed ?? 'application/octet-stream',",
    replace: '    contentType: declaredContentType,',
    tests: ['tests/e2e/files.test.ts'],
    testName: 'decides the content type by magic bytes',
  },
  {
    name: 'an upload declaring an oversized length never starts',
    package: 'api',
    file: 'src/routes/files.ts',
    // Without this the body is read to the cap and refused there, which costs
    // the whole transfer and can no longer say how big the file was.
    find:
      '    assertUploadSize(declaredLength);\n' +
      '    if (declaredLength > 0) await assertQuota(c, projectId, declaredLength);',
    replace: '    if (declaredLength > 0) await assertQuota(c, projectId, declaredLength);',
    tests: ['tests/e2e/files.test.ts'],
    testName: 'refuses an upload whose declared length is over the limit',
  },
  {
    name: 'an oversized upload is refused before it is sent',
    package: 'web',
    file: 'src/lib/upload.ts',
    find: '  if (byteSize > MAX_UPLOAD_BYTES) {',
    replace: '  if (false) {',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'refuses a file over the limit without sending it',
    runner: 'web',
  },
  {
    name: 'a refused upload reaches the screen as what the API said',
    package: 'web',
    file: 'src/lib/upload.ts',
    // apiMessage shows an ApiError and nothing else, so the plain Error the
    // explorer threw before reached the toast as "could not reach the server".
    find: '  if (!response.ok) throw new ApiError(response.status, body.error ?? fallback, body);',
    replace: '  if (!response.ok) throw new Error(body.error ?? fallback);',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'carries the refusal the API wrote out to the caller',
    runner: 'web',
  },
  {
    name: 'the upload cap does not leave its refusal unhandled',
    package: 'api',
    file: 'src/services/files.ts',
    // Without the listener the cap emits on a stream nothing is watching yet,
    // which is an uncaught exception rather than a 413.
    find: "  counted.on('error', () => {});",
    replace: '  void counted;',
    tests: ['src/services/files.test.ts'],
    testName: 'refuses a body past the cap',
  },
  {
    name: 'RIFF that is not WebP is not an image',
    package: 'api',
    file: 'src/services/imageSniff.ts',
    find: 'startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)',
    replace: 'true',
    tests: ['src/services/imageSniff.test.ts'],
    testName: 'does not accept RIFF without the WEBP tag',
  },
  {
    name: 'a mutation that fails rolls the whole request back',
    package: 'api',
    file: 'src/middleware/transaction.ts',
    // Without the rethrow, Hono's compose has already swallowed the error onto
    // c.error and Kysely sees a clean return -- so the partial write commits.
    find: '    if (c.error) throw c.error;',
    replace: '    if (false) throw c.error;',
    tests: ['tests/unit/transactionMiddleware.test.ts'],
    testName: 'rolls back a write when a later step in the same request throws',
  },
  {
    name: 'a reset link cannot be spent twice',
    package: 'api',
    file: 'src/routes/auth.ts',
    find: "        alternative_id: newId(),\n        updated_at: new Date(),\n      })\n      .where('app_user.id', '=', claims.sub)",
    replace:
      "        updated_at: new Date(),\n      })\n      .where('app_user.id', '=', claims.sub)",
    tests: ['tests/e2e/auth.test.ts'],
    testName: 'mails a link that sets a new password exactly once',
  },
  {
    name: 'one token family cannot be spent as another',
    package: 'api',
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
    package: 'api',
    file: 'src/routes/auth.ts',
    find: "      throw new AppError(401, 'Invalid email or password');\n    }\n\n    if (!(await verifyPassword(row.password_hash, password))) {",
    replace:
      "      throw new AppError(401, 'No account with that email');\n    }\n\n    if (!(await verifyPassword(row.password_hash, password))) {",
    tests: ['tests/e2e/auth.test.ts'],
    testName: 'answers 401 identically for an unknown address',
  },
  {
    name: 'undeclared request fields are stripped, not stored',
    package: 'api',
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
    package: 'api',
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
    package: 'api',
    file: 'src/services/realtime/transport.ts',
    find: '          if (allowed) connection.socket.send(message);',
    replace: '          void allowed; connection.socket.send(message);',
    tests: ['tests/e2e/realtime.test.ts'],
    testName: 'delivers nothing to someone who subscribed to a project they cannot read',
  },
  {
    name: 'nothing is published for a request that rolled back',
    package: 'api',
    file: 'src/services/realtime/index.ts',
    find: '  hooks.push(async () => {',
    replace: '  void hooks;\n  void (async () => {',
    tests: ['tests/unit/realtimeBus.test.ts'],
    testName: 'publishes nothing until the hook it queued is run',
  },
  {
    name: 'a superseded directory load does not overwrite a newer one',
    package: 'web',
    file: 'src/lib/files.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
  {
    name: 'a signed-out visitor is sent to login',
    package: 'web',
    file: 'src/lib/session.svelte.ts',
    find: "    if (this.status === 'anon' && !isPublic) {",
    replace: '    if (false) {',
    tests: ['src/lib/guard.svelte.test.ts'],
    testName: 'sends a signed-out visitor to login',
    runner: 'web',
  },
  {
    name: 'an html page containing an inline svg is not an svg',
    package: 'api',
    file: 'src/services/imageSniff.ts',
    find: '  return /^<svg[\\s/>]/i.test(skipXmlPreamble(text));',
    replace: "  return text.includes('<svg');",
    tests: ['src/services/imageSniff.test.ts'],
    testName: 'does not accept HTML with an inline svg element',
  },
  {
    name: 'saving 3D settings needs write access, not merely read',
    package: 'api',
    file: 'src/routes/models.ts',
    find: "    const access = await assertFileAccess(c, fileId, 'write');",
    replace: "    const access = await assertFileAccess(c, fileId, 'read');",
    tests: ['tests/e2e/models.test.ts'],
    testName: 'a viewer is refused with 403',
  },
  {
    name: 'the back face of a card is mirrored',
    package: 'web',
    file: 'src/lib/model3d/geometry/faceGroups.ts',
    find: '    const u = nz > 0 ? (x - bounds.minX) / width : (bounds.maxX - x) / width;',
    replace: '    const u = (x - bounds.minX) / width;',
    tests: ['src/lib/model3d/geometry/faceGroups.test.ts'],
    testName: 'mirrors the back face across the front',
    runner: 'web',
  },
  {
    name: 'a bevel does not grow the piece past the size it was given',
    package: 'web',
    file: 'src/lib/model3d/geometry/extrude.ts',
    find: '    bevelOffset: -bevel,',
    replace: '    bevelOffset: 0,',
    tests: ['src/lib/model3d/geometry/faceGroups.test.ts'],
    testName: 'builds a card in metres, straddling the origin',
    runner: 'web',
  },
  {
    name: 'no screen is mounted before the first-load guard has run',
    package: 'web',
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
    name: 'the projects list is asked for once per screen',
    package: 'web',
    file: 'src/lib/projects.svelte.ts',
    find: '    this.#attempt ??= this.#load();',
    replace: '    this.#attempt = this.#load();',
    tests: ['src/lib/projects.svelte.test.ts'],
    testName: 'asks the server once even when the screen asks again',
    runner: 'web',
  },
  {
    name: 'a reset forgets the attempt the previous account made',
    package: 'web',
    file: 'src/lib/projects.svelte.ts',
    find: '    this.loading = false;\n    this.#attempt = null;',
    replace: '    this.loading = false;',
    tests: ['src/lib/projects.svelte.test.ts'],
    testName: 'asks again for the next account after a reset',
    runner: 'web',
  },
  {
    name: 'the storage meter counts every version, not just the current one',
    package: 'api',
    file: 'src/services/files.ts',
    // Summing the mirror counts each file once, at its newest size, so the
    // meter drifts further from the truth with every version that is kept.
    find: "eb.fn.sum<string>('file_version.byte_size')",
    replace: "eb.fn.sum<string>('file.byte_size')",
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 'counts every version against the project quota',
  },
  {
    name: 'a restore copies the object forward rather than re-pointing at the old one',
    package: 'api',
    file: 'src/routes/files.ts',
    // Two versions naming one object means deleting either takes the other's
    // bytes. The unique index on file_version.storage_key is what turns this
    // into a constraint failure instead of silent aliasing.
    find: '    const destinationKey = newId();',
    replace: '    const destinationKey = source.storage_key;',
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 'restores an older version by appending a copy',
  },
  {
    name: 'identical bytes do not create a version',
    package: 'api',
    file: 'src/services/files.ts',
    find: '  return current.checksum !== null && current.checksum === candidate.checksum;',
    replace: '  return false;',
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 're-uploading identical bytes creates nothing',
  },
  {
    name: 'a superseded version listing cannot overwrite a newer one',
    package: 'web',
    file: 'src/lib/versions.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/versions.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
  {
    name: 'the screen is told when identical bytes created nothing',
    package: 'web',
    file: 'src/lib/versions.svelte.ts',
    find: '    return body.created === true;',
    replace: '    return true;',
    tests: ['src/lib/versions.svelte.test.ts'],
    testName: 'reports that identical bytes created nothing',
    runner: 'web',
  },
  {
    name: 'the object URL outlives the click that reads it',
    package: 'web',
    file: 'src/lib/download.ts',
    // Only Chromium takes its blob reference during the click's synchronous
    // dispatch, so a same-task revoke passes every check run against it and
    // downloads nothing in Firefox and WebKit.
    find: '  setTimeout(() => URL.revokeObjectURL(url), 0);',
    replace: '  URL.revokeObjectURL(url);',
    tests: ['src/lib/download.test.ts'],
    testName: 'defers revoking the object URL until after the click',
    runner: 'web',
  },
  {
    name: 'a reconnected socket replays what it was watching',
    package: 'web',
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
    package: 'web',
    file: 'src/lib/realtime.svelte.ts',
    find: "      if (action === 'revalidate') return;",
    replace: '      if (false) return;',
    tests: ['src/lib/realtime.svelte.test.ts'],
    testName: 'does not reconnect after the server says the credential is gone',
    runner: 'web',
  },
  {
    name: 'a thumbnail presents the credential its bytes are behind',
    package: 'web',
    file: 'src/components/Thumbnail.svelte',
    // Exactly the shape the `<img src>` this replaced had: a request the
    // browser makes on its own carries no Authorization header, and every
    // thumbnail in the explorer answered 401.
    find:
      '        const response = await fetch(`/api/files/${id}/download${query}`, {\n' +
      '          headers: authHeader(),\n' +
      '        });',
    replace: '        const response = await fetch(`/api/files/${id}/download${query}`);',
    tests: ['src/components/Thumbnail.svelte.test.ts'],
    testName: 'reads the bytes with the credential and shows them',
    runner: 'web',
  },
  {
    // Yesterday's row drawn with today's artwork is precisely the lie the whole
    // history feature exists to prevent.
    name: 'a history thumbnail is drawn at the version the run left',
    package: 'web',
    file: 'src/routes/DeckRun.svelte',
    find: 'version={card.file_version_number ?? undefined}',
    replace: 'version={undefined}',
    tests: ['src/routes/DeckRun.svelte.test.ts'],
    testName: 'asks for each thumbnail at the version this run left',
    runner: 'web',
  },
  {
    // Both panes falling back to the current file makes every comparison look
    // like two copies of the same image.
    name: 'a comparison reads each side at its own version',
    package: 'web',
    file: 'src/routes/FileVersions.svelte',
    find: 'version={side.version_number}',
    replace: 'version={undefined}',
    tests: ['src/routes/FileVersions.svelte.test.ts'],
    testName: 'draws each side at its own version, not the current file',
    runner: 'web',
  },
  {
    // Purging is the one destructive act in the system, and a card it took is
    // named rather than requested as bytes nothing can serve.
    name: 'a purged card is named rather than drawn',
    package: 'web',
    file: 'src/routes/DeckRun.svelte',
    find: '{#if card.file_id === null}',
    replace: '{#if false}',
    tests: ['src/routes/DeckRun.svelte.test.ts'],
    testName: 'names a purged card instead of drawing a broken thumbnail',
    runner: 'web',
  },
  {
    // The route block is not keyed, so a slower listing landing late would
    // otherwise put one deck's runs under another deck's heading.
    name: 'a superseded run listing cannot overwrite a newer one',
    package: 'web',
    file: 'src/lib/deckHistory.svelte.ts',
    find: '      if (generation !== this.#runsGeneration) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/deckHistory.svelte.test.ts'],
    testName: 'discards a run listing a newer request has already superseded',
    runner: 'web',
  },
  {
    name: "a deck's history belongs to the deck it was read for",
    package: 'web',
    file: 'src/lib/deckHistory.svelte.ts',
    find: '    this.runsDeckId = null;\n    this.runs = [];\n',
    replace: '',
    tests: ['src/lib/deckHistory.svelte.test.ts'],
    testName: "drops the previous deck's runs before the next deck's answer lands",
    runner: 'web',
  },
  {
    // A readiness probe that answers from memory alone puts a pod with no
    // database back into the load balancer's rotation.
    name: 'health reaches the database rather than answering ok regardless',
    package: 'api',
    file: 'src/routes/health.ts',
    find: "    await ping(c.get('db'));",
    replace: '',
    tests: ['tests/e2e/health.test.ts'],
    testName: 'reaches the database rather than answering from memory alone',
  },
  {
    name: 'a database missing a migration is reported as behind',
    package: 'api',
    file: 'src/db/migrate.ts',
    // The failure that matters is the quiet one: a check that always says the
    // database is current is indistinguishable from not having the check.
    find: '    .filter((migration) => migration.executedAt === undefined)',
    replace: '    .filter(() => false)',
    tests: ['tests/unit/pendingMigrations.test.ts'],
    testName: 'names a migration the database has never run',
  },
  {
    name: 'the directory listing hides what has been deleted',
    package: 'api',
    file: 'src/routes/files.ts',
    find: "        .where('file.project_id', '=', projectId)\n        .where('file.deleted_at', 'is', null)",
    replace: "        .where('file.project_id', '=', projectId)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'hides a soft-deleted file from the directory listing',
  },
  {
    name: 'deleting a file keeps its bytes unless a purge was asked for',
    package: 'api',
    file: 'src/routes/files.ts',
    find: "  return query.purge === 'true';",
    replace: '  return true;',
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'keeps every version and every stored object when a file is deleted',
  },
  {
    name: 'a deleted file refuses a new version instead of quietly gaining one',
    package: 'api',
    file: 'src/services/files.ts',
    find: '  if (file.deleted_at !== null) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'refuses a new version for a deleted file',
  },
  {
    name: 'a purge reaches the tombstones inside the folder it is reclaiming',
    package: 'api',
    file: 'src/routes/files.ts',
    // The mutation ADDS a predicate rather than removing one. Every listing
    // filters tombstones, so adding it here is the plausible mistake -- and it
    // orphans every tombstoned file's objects with nothing left naming them.
    find: "            .where('file.id', 'in', fileIds)",
    replace:
      "            .where('file.id', 'in', fileIds)\n            .where('file.deleted_at', 'is', null)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'purging a folder reclaims the objects of a tombstone inside it',
  },
  {
    name: 'a purge walks through the deleted folders inside what it is reclaiming',
    package: 'api',
    file: 'src/routes/files.ts',
    // The same plausible edit as the guard above, one construct higher, and it
    // leaks strictly more: the cascade still takes every row under a deleted
    // folder, so their objects are left with nothing naming them at all.
    find: "              .select(['f.id as id'])",
    replace:
      "              .select(['f.id as id'])\n              .where('f.deleted_at', 'is', null)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'purging a folder reclaims the objects of a tombstone inside it',
  },
  {
    name: 'a superseded deleted listing cannot overwrite a newer one',
    package: 'web',
    file: 'src/lib/deleted.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/deleted.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
  {
    // The one that looks right in every screenshot and is wrong on every sheet.
    // A three-column grid makes it worse: the set of positions a backing page
    // occupies is symmetric either way, so only the pairing gives it away.
    name: 'a backing page is mirrored, so a back lands behind its own front',
    package: 'api',
    file: 'packages/shared/src/print.ts',
    root: true,
    find: '  return { index: row * grid.columns + (grid.columns - 1 - column), rotate_180 };',
    replace: '  return { index: row * grid.columns + column, rotate_180 };',
    tests: ['src/print.test.ts'],
    testName: 'puts a long-edge back where the paper flip lands it',
    runner: 'shared',
  },
  {
    // The upright rule, applied to a card the grid has laid on its side. Every
    // back still lands in the right box; every one comes out upside down once
    // the card is cut.
    name: 'a turned card’s back is inverted by the flip that crosses its top',
    package: 'api',
    file: 'packages/shared/src/print.ts',
    root: true,
    find: "  const rotate_180 = (flip === 'short') !== grid.rotated;",
    replace: "  const rotate_180 = flip === 'short';",
    tests: ['src/print.test.ts'],
    testName: 'draws a long-edge back upside down relative to its front on a turned grid',
    runner: 'shared',
  },
  {
    // The bug in the first sheet of minis anyone printed: the planner turned the
    // cell and the renderer drew the artwork upright in it, so eighteen boxes
    // each held a clipped band of a card twice their height.
    name: 'artwork on a turned grid is drawn through the turn',
    package: 'web',
    file: 'src/lib/print/pdf.ts',
    find: '    const turn: QuarterTurns = plan.grid.rotated ? 1 : 0;',
    replace: '    const turn: QuarterTurns = 0;',
    tests: ['src/lib/print/pdf.test.ts'],
    testName: 'turns every card of a turned grid onto its side',
    runner: 'web',
  },
  {
    // Six cards a sheet on minis, and nothing about the output looks wrong --
    // it is simply a third more paper than it needed to be.
    name: 'the packing tries the card turned as well as upright',
    package: 'api',
    file: 'packages/shared/src/print.ts',
    root: true,
    find: '  const rotated = turned.columns * turned.rows > upright.columns * upright.rows;',
    replace: '  const rotated = false;',
    tests: ['src/print.test.ts'],
    testName: 'fits mini cards 18 to a US Letter sheet',
    runner: 'shared',
  },
  {
    // Asserting access where a mutation needs write is the defect convention 4
    // names, and it reads as a plausible copy from the route above it.
    name: 'replacing a deck’s cards asserts write, not merely access',
    package: 'api',
    file: 'src/routes/decks.ts',
    find:
      "    const access = await assertDeckAccess(c, deckId, 'write');\n" +
      "    const { cards } = c.req.valid('json')",
    replace:
      "    const access = await assertDeckAccess(c, deckId, 'read');\n" +
      "    const { cards } = c.req.valid('json')",
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'refuses a viewer editing the cards with 403',
  },
  {
    // Carrying the removal row forward reads as the card still standing, which
    // is the one thing an as-of view exists to get right.
    name: 'the deck as it stood stops carrying a card the import removed',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find: "where r.rn = 1 and r.outcome <> 'removed'",
    replace: 'where r.rn = 1',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'leaves out a card that import removed',
  },
  {
    // An open run has not removed anything yet, so answering it at all hands
    // back a deck that never existed.
    name: 'an import still running is refused rather than half-answered',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find: "  if (row.status === 'open') {",
    replace: '  if (false) {',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'refuses a run that is still open',
  },
  {
    // Without the deck in the path a hand-edited URL renders another deck's
    // history under this deck's name. One helper scopes both reads of a run,
    // so either of them catches this.
    name: 'a run from another deck is not readable through this deck',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find:
      "    .where('import_run.import_id', '=', importId)\n" +
      '    .executeTakeFirst();\n' +
      "  if (!row) throw new AppError(404, 'Import run not found');",
    replace:
      '    .executeTakeFirst();\n' + "  if (!row) throw new AppError(404, 'Import run not found');",
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'answers 404 for a run belonging to another deck',
  },
  {
    // An abandoned run writes real ledger rows: its pages landed and its
    // versions are on disk. The deck was handed none of it, and this predicate
    // is the whole of what keeps those rows out of the answer -- the honesty of
    // the view rests on it and nothing else asserts it.
    name: 'an abandoned run is left out of the deck as it stood',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find: "where r.status = 'finished' and (r.started_at, r.id) <= (a.started_at, a.id)",
    replace: 'where (r.started_at, r.id) <= (a.started_at, a.id)',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'leaves out an abandoned run inside a later window',
  },
  {
    // The route answers 404 for a deck that is not bound at all, which is not
    // the same 404 as a deck nobody may read.
    name: 'a deck with no import is offered a binding, not an error',
    package: 'web',
    file: 'src/lib/deckImports.svelte.ts',
    find: '      if (caught instanceof ApiError && caught.status === 404) {',
    replace: '      if (false) {',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'treats a 404 from the binding route as a deck nothing has imported into',
    runner: 'web',
  },
  {
    name: 'a superseded binding load does not overwrite a newer one',
    package: 'web',
    file: 'src/lib/deckImports.svelte.ts',
    find: '      if (generation !== this.#bindingGeneration) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'discards a binding response that a newer request has already superseded',
    runner: 'web',
  },
  {
    // The screens are not remounted when the deck in the URL changes, so the
    // binding left in the store is read as the next deck's, open run and all.
    name: 'a binding belongs to the deck it was read for',
    package: 'web',
    file: 'src/lib/deckImports.svelte.ts',
    find: '    this.bindingDeckId = null;\n    this.binding = null;\n',
    replace: '',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'drops the previous deck',
    runner: 'web',
  },
  {
    // Reading the prop straight is what every other component here does, and it
    // looks like a needless indirection to take out. Inside a keyed each the
    // prop is a getter over the row, so the effect subscribes to the row and one
    // copy count edit blanks and re-reads every image in the deck.
    name: 'an identity-only prop change does not re-read a thumbnail',
    package: 'web',
    file: 'src/components/Thumbnail.svelte',
    find: '    const id = currentFileId;',
    replace: '    const id = fileId;',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'does not reload the thumbnails when a copy count changes',
    runner: 'web',
  },
  {
    // The listing is ordered by the server. Appending instead of inserting puts
    // the row in the wrong place until the next load, which is exactly the kind
    // of drift that made patching look riskier than reloading.
    name: 'a row applied to the listing lands where a reload would have put it',
    package: 'web',
    file: 'src/lib/files.svelte.ts',
    find: '    next.sort((a, b) => key(a).localeCompare(key(b)));',
    replace: '    void key;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'inserts an uploaded file in the order the listing is sorted in',
    runner: 'web',
  },
  {
    // The folder on screen going away is the one event this store cannot
    // absorb. Answering true leaves the explorer showing a folder that has
    // stopped existing.
    name: 'a deleted open folder falls back to a reload',
    package: 'web',
    file: 'src/lib/files.svelte.ts',
    find: '        if (listing.folder?.id === gone || listing.breadcrumb.some((entry) => entry.id === gone)) {\n          return false;\n        }',
    replace: '        void gone;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'asks for a reload when the folder being shown is deleted',
    runner: 'web',
  },
  {
    // The same shape one level out: decks.deck is a new object after every
    // save, so reading the field off it re-read a row whose id had not moved.
    name: 'an unchanged card back is not read again',
    package: 'web',
    file: 'src/routes/Deck.svelte',
    find: '    const id = backFileId;',
    replace: '    const id = decks.deck?.back_file_id ?? null;',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'does not re-read the card back when a copy count changes',
    runner: 'web',
  },
  {
    // Nothing reads the deck back any more, so dropping the apply does not fall
    // through to a slower path -- the change simply never reaches the screen.
    name: 'what a deck_updated carried reaches the screen',
    package: 'web',
    file: 'src/routes/Deck.svelte',
    find: '          decks.applyDeckUpdate(event.data.deck, event.data.cards);\n          return;',
    replace: '          return;',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'applies a deck_updated that carries the rows instead of reading the deck back',
    runner: 'web',
  },
  {
    // The screen checks this too, but the store is where it is load-bearing:
    // one project holds several decks, and an event for a sibling would
    // otherwise replace the open one wholesale.
    name: 'an event for another deck does not replace the open one',
    package: 'web',
    file: 'src/lib/decks.svelte.ts',
    find: '    if (this.deck?.id !== deck.id) return;',
    replace: '    if (false) return;',
    tests: ['src/lib/decks.svelte.test.ts'],
    testName: 'ignores an event for a deck that is not the one open',
    runner: 'web',
  },
  {
    // Applying answers no request, so it sits outside the generation counters
    // that keep two loads in order. Without this the older of the two wins
    // whenever it is the one that lands second.
    name: 'a response older than what was applied does not overwrite it',
    package: 'web',
    file: 'src/lib/decks.svelte.ts',
    find: '      if (this.#supersededBy(data.deck)) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/decks.svelte.test.ts'],
    testName: 'does not let a response older than what was applied overwrite it',
    runner: 'web',
  },
  {
    // The importer recomputes the range the same way and would refuse a
    // document whose shots run past it, so a hand-supplied range is a bundle
    // Blender never opens.
    name: 'a scene ends on the last frame its shots reach',
    package: 'api',
    file: 'packages/shared/src/scenes.ts',
    root: true,
    find: '      frame_range: sceneFrameRange(draft.shots, draft.instances, render.fps),',
    replace: '      frame_range: [1, 1],',
    tests: ['src/scenes.test.ts'],
    testName: 'stamps the format and derives the frame range from the shots',
    runner: 'shared',
  },
  {
    // Deduplicating on the settings alone is the tempting version, and it hands
    // fifty-two cards one file: every card in a deck is cut to one size.
    name: 'two cards printed with different artwork are two files',
    package: 'web',
    file: 'src/lib/scene/assets.ts',
    find:
      '    component.settings,\n' +
      '    component.front.file_id,\n' +
      '    component.back?.file_id ?? null,\n',
    replace: '    component.settings,\n',
    tests: ['src/lib/scene/assets.test.ts'],
    testName: 'separates two cards cut to one size but printed with different artwork',
    runner: 'web',
  },
  {
    // Exporting a deck is a minute of geometry, and a document the importer
    // refuses is worth hearing about at the start of that minute.
    name: 'a document the importer would refuse is refused before a file is built',
    package: 'web',
    file: 'src/lib/scene/bundle.ts',
    find: '  if (issues.length > 0) throw new SceneExportError(describeIssues(issues), issues);',
    replace: '  void issues;',
    tests: ['src/lib/scene/bundle.test.ts'],
    testName: 'refuses a document the importer would refuse, before it builds a single file',
    runner: 'web',
  },
  {
    // The quarter turn the glTF Y-up conversion makes necessary. Without it
    // every card in the scene stands on its edge and no shot puts it down.
    name: 'an imported component is laid flat, and a library piece is not',
    package: 'web',
    file: 'src/lib/scene/layout.ts',
    find: 'const FLAT_ROTATION_DEG: Vec3 = [-90, 0, 0];',
    replace: 'const FLAT_ROTATION_DEG: Vec3 = [0, 0, 0];',
    tests: ['src/lib/scene/assets.test.ts'],
    testName: 'lays an imported component flat, because the glTF conversion stands it up',
    runner: 'web',
  },
  {
    // The whole point of the boundary: the document is millimetres and Blender
    // counts in metres, so every value crosses scenedoc.MM exactly once on the
    // way out. The two location channels of a deal are written side by side and
    // converted per value, which is what makes dropping it on one of them the
    // plausible slip rather than a nonsense.
    name: 'a dealt position crosses the millimetre boundary exactly once',
    package: 'blender',
    file: 'shots.py',
    find:
      '            _pair(LOCATION, 0, start_s, rest[0] * MM, end_s, slot[0] * MM, ' +
      "('QUAD', 'EASE_OUT')),",
    replace:
      "            _pair(LOCATION, 0, start_s, rest[0], end_s, slot[0], ('QUAD', 'EASE_OUT')),",
    tests: ['tests/test_shots.py'],
    testName: 'test_a_card_sized_position_arrives_in_metres',
    runner: 'python',
  },
  {
    // Six faces over one wrap, so a region that overlaps its neighbour is two
    // faces sampling one piece of artwork -- and the box still builds, still
    // textures and still exports, wearing the front panel on its back.
    name: 'no two faces of a box net share a piece of the wrap',
    package: 'api',
    file: 'packages/shared/src/models3d.ts',
    root: true,
    find: '    back: rect(2 * d + w, d, 2 * d + 2 * w, d + h),',
    replace: '    back: rect(d, d, d + w, d + h),',
    tests: ['src/models3d.test.ts'],
    testName: 'never overlaps two faces',
    runner: 'shared',
  },
  {
    // The floor this replaces was written when a card was in a deck at least
    // once, and it is exactly the line a reader restores on sight. Back in
    // place it puts a card the deck prints none of on the table, and builds and
    // ships a .glb for it.
    name: 'a card the deck holds no copies of stays off the table',
    package: 'web',
    file: 'src/lib/scene/assets.ts',
    find: '  return Math.max(0, Math.floor(count));',
    replace: '  return Math.max(1, Math.floor(count));',
    tests: ['src/lib/scene/assets.test.ts'],
    testName: 'leaves a card the deck holds no copies of off the table entirely',
    runner: 'web',
  },
  {
    // The other direction from the assetKey guard, and the expensive one: with
    // the registry handing out a new id per selection, a deck of fifty-two
    // cards builds fifty-two geometries and the bundle carries every one.
    name: 'one component is built once however many times it was picked',
    package: 'web',
    file: 'src/lib/scene/assets.ts',
    find:
      '    const key = assetKey(component);\n' +
      '    const existing = this.#ids.get(key);\n    if (existing) return existing;',
    replace: '    const key = assetKey(component);',
    tests: ['src/lib/scene/assets.test.ts'],
    testName: 'collapses a deck onto one asset per distinct card and one instance per copy',
    runner: 'web',
  },
  {
    // Everything in a scene rests on z = 0, and a table is the one thing built
    // the other way up. Standing it on that plane is what every library piece
    // does and is the natural slip -- and it buries the whole selection one
    // tabletop deep.
    name: 'the table hangs below the plane the pieces stand on',
    package: 'blender',
    file: 'stage.py',
    find: '            [(-half, -thickness_m), (half, -thickness_m), (half, 0.0), (-half, 0.0)],',
    replace: '            [(-half, 0.0), (half, 0.0), (half, thickness_m), (-half, thickness_m)],',
    tests: ['tests/test_stage.py'],
    testName: 'test_the_top_is_the_plane_the_pieces_already_rest_on',
    runner: 'python',
  },
  {
    // An orbit takes the camera round behind the subject, and a sweep is a
    // wall. Leaving it standing is the version that reads fine until half the
    // shot is a render of the back of a backdrop.
    name: 'a shot that circles the table is given no backdrop to circle behind',
    package: 'web',
    file: 'src/lib/scene/bundle.ts',
    find: "  const circles = shots.shots.some((shot) => shot.kind === 'orbit');",
    replace: '  const circles = false;',
    tests: ['src/lib/scene/bundle.test.ts'],
    testName: 'flattens the backdrop for a shot that circles the table',
    runner: 'web',
  },
  {
    // The margin halfFields holds back is what keeps the subject clear of the
    // frame edges; a backdrop has the opposite job. Sizing one through the
    // same call without putting the margin back cuts it to the subject's
    // frame, which is narrower than the real one by exactly that factor -- and
    // the world shows either side of it.
    name: 'a backdrop is cut to the whole frame, not to the subject-safe one',
    package: 'web',
    file: 'src/lib/scene/layout.ts',
    find: '    half_width_mm: field.h * FRAMING_MARGIN * reach,',
    replace: '    half_width_mm: field.h * reach,',
    tests: ['src/lib/scene/layout.test.ts'],
    testName: 'fills the frame where the backdrop stands, not merely where the cards do',
    runner: 'web',
  },
  {
    // The list a deck answers with is the list its editor sends back, and a
    // deleted card is in it. Filtering the tombstones out of what may be named
    // reads like the liveness filter every other listing carries -- and it
    // leaves a deck holding one deleted card unable to change any card's copy
    // count at all, which is what it did.
    name: 'a deck holding a deleted card can still be edited',
    package: 'api',
    file: 'src/services/decks.ts',
    find: "    .where('file.deck_id', '=', deckId)\n",
    replace: "    .where('file.deck_id', '=', deckId)\n    .where('file.deleted_at', 'is', null)\n",
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'takes the list the deck answers with, tombstone and all',
  },
  {
    // The other half of the same asymmetry. An import takes a card out of the
    // arrangement as it tombstones the artwork, so demanding a row it deleted
    // jams the editor from the other side -- a list refused for leaving out a
    // card the deck no longer shows anywhere.
    name: 'only live artwork has to have a place in the deck',
    package: 'api',
    file: 'src/services/decks.ts',
    find: '    (row) => row.deleted_at === null && !given.has(row.id) && row.id !== deck.back_file_id',
    replace: '    (row) => !given.has(row.id) && row.id !== deck.back_file_id',
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'lets a list leave the tombstone out, and saves again after',
  },
  {
    // The deck editor validates a whole list against the cap, so a deck any
    // other arrival has pushed past it is one no hand edit can save again. The
    // check reads like belt and braces beside the import's own, which is
    // exactly why it goes missing.
    name: 'an upload cannot push a deck past its card cap',
    package: 'api',
    file: 'src/routes/files.ts',
    find:
      "    if (home.kind === 'deck' && deckRole === 'card') {\n" +
      '      await assertRoomForCard(db, home.deckId, id);\n' +
      '    }\n',
    replace: '',
    tests: ['tests/e2e/fileHomes.test.ts'],
    testName: 'refuses an upload of one more card, before the bytes go up',
  },
  {
    // A restore is the one arrival that may find no place kept: an import's
    // removal took the row with it. Leaving the file to come back on its own
    // is the natural reading of a restore, and it puts live artwork in a deck
    // that no list names -- which the deck editor then refuses to save.
    name: 'a restored card is given a place in its deck again',
    package: 'api',
    file: 'src/routes/files.ts',
    find: "    if (home.kind === 'deck') await rejoinDeck(c, access.projectId, home.deckId, id);\n",
    replace: '',
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'gives a restored card a new place at the end',
  },
  {
    // The one field in the central directory a reader cannot recompute. Every
    // other number in the record repeats one the local header already carries,
    // so a wrong offset is the single way to write an archive that looks
    // complete, unzips without complaint, and hands back the wrong bytes.
    name: 'the central directory points at the local header it names',
    package: 'web',
    file: 'src/lib/scene/zip.ts',
    find: '    writer.u32(entry.localOffset);',
    replace: '    writer.u32(0);',
    tests: ['src/lib/scene/zip.test.ts'],
    testName: 'keeps every offset straight across an archive of many entries',
    runner: 'web',
  },
  {
    // The half of the rule that reaches a deck imported before any of it
    // existed, where the back is already a card at one copy. Only the insert
    // reads as load-bearing, and dropping this branch is the tidy-up somebody
    // makes on the strength of the import never touching a copy count -- which
    // leaves every deck that has ever been imported printing its own back on
    // the front of a sheet, and nothing in the run saying so.
    name: 'a page titled Back takes a card it already has to no copies',
    package: 'api',
    file: 'src/services/deckImport.ts',
    find: '  } else if (isBack && existing.quantity !== 0) {',
    replace: '  } else if (false) {',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'takes an existing card to no copies, so a deck imported before this catches up',
  },
  {
    // Comparing the file alone and not the version it is at. A deck given new
    // artwork for its back then reads as fully printed, and every card in it
    // goes on carrying a reverse that is one version out -- the one kind of
    // staleness no comparison of fronts can see.
    name: 'a new version of the back asks for the cards behind it again',
    package: 'api',
    file: 'src/services/printRuns.ts',
    find: '  return group.back_file_id === backFileId && group.back_version_number === backVersion;',
    replace: '  return group.back_file_id === backFileId;',
    tests: ['tests/e2e/printRuns.test.ts'],
    testName: 'owes every card again when the deck is given a new back',
  },
  {
    // Counting every copy ever printed rather than the copies printed at the
    // artwork the card carries now. It reads as a simplification -- the sum is
    // right there -- and it makes re-importing a card invisible to the one
    // screen that exists to notice it.
    name: 'copies printed at an older version do not count towards this one',
    package: 'api',
    file: 'src/services/printRuns.ts',
    find: '  const atVersion = groups.filter((group) => group.version_number === version);',
    replace: '  const atVersion = groups;',
    tests: ['tests/e2e/printRuns.test.ts'],
    testName: 'owes the whole card again when its artwork is versioned',
  },
  {
    // Dropping the pinned versions leaves the document drawn from whatever each
    // file is at now while the ledger records the numbers the screen was told
    // -- so a card re-imported while the print screen sat open is written down
    // as printed at a version that never went through the printer.
    name: 'the sheets are drawn at the versions the run is recorded with',
    package: 'web',
    file: 'src/routes/Print.svelte',
    find: '        { decks: runDecks, options, versions: $state.snapshot(versions) },',
    replace: '        { decks: runDecks, options },',
    tests: ['src/routes/Print.svelte.test.ts'],
    testName: 'draws every card at the version it records, backs included',
    runner: 'web',
  },
];
