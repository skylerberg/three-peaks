// Pushing a Canva design into a deck, and reading the history of one back.

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
    // The tiers exist in an order, and the order is the design: an id settles a
    // page before a title does. Running the title tier first is a one-line
    // reordering that reads as harmless and quietly hands each card to whatever
    // page happens to share its name.
    name: 'a page id outranks a title, never the other way round',
    file: 'src/services/deckImport/planning.ts',

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
    name: 'a finished import leaves the deck in the design’s order',
    file: 'src/services/deckImport/finish.ts',

    find: '  await orderDeckToExport(c, access);\n',
    replace: '',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'follows the design when its pages are moved around',
  },
  {
    // Yesterday's row drawn with today's artwork is precisely the lie the whole
    // history feature exists to prevent.
    name: 'a history thumbnail is drawn at the version the run left',
    file: 'src/routes/DeckRun.svelte',
    find: 'version={card.file_version_number ?? undefined}',
    replace: 'version={undefined}',
    tests: ['src/routes/DeckRun.svelte.test.ts'],
    testName: 'asks for each thumbnail at the version this run left',
    runner: 'web',
  },
  {
    // Purging is the one destructive act in the system, and a card it took is
    // named rather than requested as bytes nothing can serve.
    name: 'a purged card is named rather than drawn',
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
    file: 'src/lib/deckHistory.svelte.ts',
    find: '      if (generation !== this.#runsGeneration) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/deckHistory.svelte.test.ts'],
    testName: 'discards a run listing a newer request has already superseded',
    runner: 'web',
  },
  {
    name: "a deck's history belongs to the deck it was read for",
    file: 'src/lib/deckHistory.svelte.ts',
    find: '    this.runsDeckId = null;\n    this.runs = [];\n',
    replace: '',
    tests: ['src/lib/deckHistory.svelte.test.ts'],
    testName: "drops the previous deck's runs before the next deck's answer lands",
    runner: 'web',
  },
  {
    // Carrying the removal row forward reads as the card still standing, which
    // is the one thing an as-of view exists to get right.
    name: 'the deck as it stood stops carrying a card the import removed',
    file: 'src/services/deckImport/history.ts',

    find: "where r.rn = 1 and r.outcome <> 'removed'",
    replace: 'where r.rn = 1',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'leaves out a card that import removed',
  },
  {
    // An open run has not removed anything yet, so answering it at all hands
    // back a deck that never existed.
    name: 'an import still running is refused rather than half-answered',
    file: 'src/services/deckImport/history.ts',

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
    file: 'src/services/deckImport/runs.ts',

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
    file: 'src/services/deckImport/history.ts',

    find: "where r.status = 'finished' and (r.started_at, r.id) <= (a.started_at, a.id)",
    replace: 'where (r.started_at, r.id) <= (a.started_at, a.id)',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'leaves out an abandoned run inside a later window',
  },
  {
    // The route answers 404 for a deck that is not bound at all, which is not
    // the same 404 as a deck nobody may read.
    name: 'a deck with no import is offered a binding, not an error',
    file: 'src/lib/deckImports.svelte.ts',
    find: '      if (caught instanceof ApiError && caught.status === 404) {',
    replace: '      if (false) {',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'treats a 404 from the binding route as a deck nothing has imported into',
    runner: 'web',
  },
  {
    name: 'a superseded binding load does not overwrite a newer one',
    file: 'src/lib/deckImports.svelte.ts',
    find: '    if (generation !== this.#bindingGeneration) return;',
    replace: '    if (false) return;',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'discards a binding response that a newer request has already superseded',
    runner: 'web',
  },
  {
    // The row a first import creates is the one this store answered 404 for, so
    // the event has nothing to patch and the run cannot be discarded until the
    // screen is loaded again.
    name: 'a first import\u2019s run reaches a deck with no row yet',
    package: 'web',
    file: 'src/lib/deckImports.svelte.ts',
    find: '      if (runId !== null) void this.#refreshBinding();',
    replace: '      void runId;',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'reads the row a first import has just created',
    runner: 'web',
  },
  {
    // The screens are not remounted when the deck in the URL changes, so the
    // binding left in the store is read as the next deck's, open run and all.
    name: 'a binding belongs to the deck it was read for',
    file: 'src/lib/deckImports.svelte.ts',
    find: '    this.bindingDeckId = null;\n    this.binding = null;\n',
    replace: '',
    tests: ['src/lib/deckImports.svelte.test.ts'],
    testName: 'drops the previous deck',
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
    file: 'src/services/deckImport/card.ts',

    find: '  } else if (isBack && existing.quantity !== 0) {',
    replace: '  } else if (false) {',
    tests: ['tests/e2e/deckImport.test.ts'],
    testName: 'takes an existing card to no copies, so a deck imported before this catches up',
  },
  {
    // The same pinning the grid behind it already does, and the one thing this
    // screen exists not to get wrong: a card opened from a run in February has
    // to be the artwork that run left, not the artwork the file carries today.
    name: 'a card opened from a history screen is opened at that run\u2019s version',
    file: 'src/routes/DeckAsOf.svelte',
    find: '              version: card.file_version_number,\n',
    replace: '',
    tests: ['src/routes/DeckAsOf.svelte.test.ts'],
    testName: 'opens a card at the version that import left, not at today\u2019s artwork',
    runner: 'web',
  },
];
