// Packing cards onto sheets, building the PDF, and the ledger of what is on paper.

export const guards = [
  {
    // The one that looks right in every screenshot and is wrong on every sheet.
    // A three-column grid makes it worse: the set of positions a backing page
    // occupies is symmetric either way, so only the pairing gives it away.
    name: 'a backing page is mirrored, so a back lands behind its own front',
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
    file: 'packages/shared/src/print.ts',
    root: true,
    find: '  const rotated = turned.columns * turned.rows > upright.columns * upright.rows;',
    replace: '  const rotated = false;',
    tests: ['src/print.test.ts'],
    testName: 'fits mini cards 18 to a US Letter sheet',
    runner: 'shared',
  },
  {
    // Comparing the file alone and not the version it is at. A deck given new
    // artwork for its back then reads as fully printed, and every card in it
    // goes on carrying a reverse that is one version out -- the one kind of
    // staleness no comparison of fronts can see.
    name: 'a new version of the back asks for the cards behind it again',
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
    file: 'src/routes/Print.svelte',
    find: '        { decks: runDecks, options, versions: $state.snapshot(versions) },',
    replace: '        { decks: runDecks, options },',
    tests: ['src/routes/Print.svelte.test.ts'],
    testName: 'draws every card at the version it records, backs included',
    runner: 'web',
  },
  {
    // The deck's box is counted off its cards rather than held beside them, so
    // that a deck somebody has part-ticked says so. Dropping the mixed state
    // leaves a box reading fully checked over a deck printing two cards of
    // three -- the one arrangement where what is on screen and what comes out
    // of the printer disagree, with nothing on the row to say which is right.
    name: 'a part-ticked deck reports itself as mixed',
    file: 'src/routes/Print.svelte',
    find: '                    indeterminate={choice.chosen > 0 && choice.chosen < choice.total}\n',
    replace: '',
    tests: ['src/routes/Print.svelte.test.ts'],
    testName: 'reports the deck as mixed while only some of its cards are ticked',
    runner: 'web',
  },
  {
    // The deck's copy count is what a card starts at and nothing more. Dropping
    // the number somebody typed leaves every field on the screen editable and
    // none of them read -- the sheets packed from the deck's own counts, the
    // ledger recording them, and the one thing on screen saying otherwise.
    name: 'a count somebody typed is the count that prints',
    file: 'src/routes/Print.svelte',
    find: '    return copies[key(deckId, card.file_id)] ?? startingCopies(deckId, card);',
    replace: '    return startingCopies(deckId, card);',
    tests: ['src/routes/Print.svelte.test.ts'],
    testName: 'prints the count somebody typed rather than the deck’s',
    runner: 'web',
  },
  {
    // Unticked and struck through is how the print screen drew one before, and
    // it reads as a card this run is choosing to skip rather than one there is
    // nothing of to print.
    name: 'the print screen does not list a deleted card',
    file: 'src/routes/Print.svelte',
    find: '        loaded = full.map((entry) => ({ ...entry, cards: entry.cards.filter(isLiveCard) }));',
    replace: '        loaded = full;',
    tests: ['src/routes/Print.svelte.test.ts'],
    testName: 'is neither listed nor counted towards its deck',
    runner: 'web',
  },
];
