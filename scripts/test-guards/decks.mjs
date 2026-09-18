// A deck and its cards -- the arrangement, the editor, and the card viewer.

export const guards = [
  {
    // Leaving an image the deck owns out of its card list would strand it: in
    // the deck, and in no list any screen draws. The other half of the same
    // rule -- refusing a file the deck does not own -- has a test of its own.
    name: 'a deck may not be left holding artwork with no place in it',
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
    // Asserting access where a mutation needs write is the defect convention 4
    // names, and it reads as a plausible copy from the route above it.
    name: 'replacing a deck’s cards asserts write, not merely access',
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
    // The same shape one level out: decks.deck is a new object after every
    // save, so reading the field off it re-read a row whose id had not moved.
    name: 'an unchanged card back is not read again',
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
    file: 'src/lib/decks.svelte.ts',
    find: '      if (this.#supersededBy(data.deck)) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/decks.svelte.test.ts'],
    testName: 'does not let a response older than what was applied overwrite it',
    runner: 'web',
  },
  {
    // A keyboard drag finalizes on every arrow press and ends with a consider,
    // so a screen that saves on each finalize writes the deck once per
    // keystroke -- and fans a realtime event out to every other tab behind each
    // of them, describing an arrangement nobody asked for.
    name: 'a keyboard drag saves once, where it ends',
    package: 'web',
    file: 'src/routes/Deck.svelte',
    find: '    if (event.detail.info.source === SOURCES.KEYBOARD) return;\n',
    replace: '',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'saves once at the end of a keyboard drag, not once per arrow',
    runner: 'web',
  },
  {
    // The drawn list is the dropped one until the save answers. Drawing the
    // store instead is the tempting simplification -- there is no second list
    // to keep -- and it makes every drop jump home and then forward again,
    // which is how it looked before.
    name: 'a dropped card stays where it was dropped while the save is in flight',
    package: 'web',
    file: 'src/routes/Deck.svelte',
    find: '          {#each localCards as card (card.id)}',
    replace: '          {#each drawCards() as card (card.id)}',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'draws the dropped order while the save is in flight',
    runner: 'web',
  },
  {
    // The list a deck answers with is the list its editor sends back, and a
    // deleted card is in it. Filtering the tombstones out of what may be named
    // reads like the liveness filter every other listing carries -- and it
    // leaves a deck holding one deleted card unable to change any card's copy
    // count at all, which is what it did.
    name: 'a deck holding a deleted card can still be edited',
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
    file: 'src/routes/files.ts',
    find: '      await rejoinDeck(c, home.deckId, id);\n',
    replace: '',
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'gives a restored card a new place at the end',
  },
  {
    // Wrapping is the plausible alternative, and it is the wrong one: the ends
    // of a deck are where somebody is checking whether they have seen every
    // card, and a viewer that silently starts again says they have not.
    name: 'the card viewer stops at the ends of the deck',
    file: 'src/components/CardViewer.svelte',
    find: '    if (next < 0 || next >= cards.length) return;',
    replace:
      '    if (next < 0 || next >= cards.length) {\n' +
      '      openId = cards[(next + cards.length) % cards.length].id;\n' +
      '      return;\n' +
      '    }',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'stops at the first and the last card rather than wrapping round',
    runner: 'web',
  },
  {
    // A modal takes the focus and has to give it back. Without this, closing
    // one leaves the focus on nothing at all, and a keyboard is back at the top
    // of a sixty-card list every time it looks at a card.
    name: 'closing the card viewer returns the focus to what opened it',
    file: 'src/components/CardViewer.svelte',
    find: '      opener?.focus();\n',
    replace: '',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'closes on Escape and gives the focus back to the row that opened it',
    runner: 'web',
  },
  {
    // A deleted card keeps its deck_card row so a restore lands where it was,
    // which makes counting the rows the obvious way to total a deck -- and a
    // deck listed as holding cards and copies that no sheet will ever carry.
    name: 'a deck’s totals leave out the cards whose images are deleted',
    file: 'src/services/decks.ts',
    find:
      "      .whereRef('deck_card.deck_id', '=', 'deck.id')\n" +
      "      .where('file.deleted_at', 'is', null);\n",
    replace: "      .whereRef('deck_card.deck_id', '=', 'deck.id');\n",
    tests: ['tests/e2e/decks.test.ts'],
    testName: 'leaves the card out while it is deleted, and counts it again once restored',
  },
  {
    // A delete that keeps the card's place moves no arrangement, so announcing
    // the file alone reads as enough. It is not: the decks listing learns its
    // totals from this event and from nothing else.
    name: 'deleting a deck’s card announces the deck',
    file: 'src/routes/files.ts',
    find:
      '        const home = parseHome(file);\n' +
      "        if (home.kind === 'deck') await publishDeck(c, access.projectId, home.deckId);\n",
    replace: '',
    tests: ['tests/e2e/realtime.test.ts'],
    testName: 'announces the deck when the card is deleted, and again when it is restored',
  },
  {
    // Sending the drawn list is what the editor did while it drew every row.
    // With the deleted ones hidden, that list leaves them out, and the server
    // accepts it -- taking the rows, and with them the place and the copy count
    // a restore was meant to give back.
    name: 'a save sends back the cards the editor is hiding',
    file: 'src/routes/Deck.svelte',
    find: '      await decks.saveCards(deckId, asInput(withHiddenCards(cards, next)));',
    replace: '      await decks.saveCards(deckId, asInput(next));',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'goes back into a reorder where it was, with its copies',
    runner: 'web',
  },
  {
    name: 'the deck editor hides deleted cards until asked',
    file: 'src/routes/Deck.svelte',
    find: '  let showDeleted = $state(false);',
    replace: '  let showDeleted = $state(true);',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'is left out of the list and the totals until it is asked for',
    runner: 'web',
  },
];
