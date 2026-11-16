// A punchboard's tokens -- the list, its faces, and the sheet packed from it.

export const guards = [
  {
    // Leaving an image the punchboard owns out of its token list would strand
    // it: in the punchboard, and on no token any screen or sheet draws.
    name: 'a punchboard may not be left holding an image that is no token’s face',
    file: 'src/services/tokens.ts',
    find: '  if (stranded.length > 0) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/punchboardTokens.test.ts'],
    testName: 'refuses a list leaving a live image out',
  },
  {
    // A back a token's layout draws is the layout's. Changing it by hand would
    // last until the next render made a new one.
    name: "a token's drawn back cannot be changed in its list",
    file: 'src/services/tokens.ts',
    find: '    if (drawnBack !== undefined && back !== drawnBack) {',
    replace: '    if (false) {',
    tests: ['tests/e2e/punchboardTokens.test.ts'],
    testName: 'refuses to change a back its layout draws, or to give it to another token',
  },
  {
    // A purged front takes its token with it; a back nothing else prints would
    // otherwise be left in the punchboard naming nothing.
    name: 'purging a token’s front takes the back that was its alone',
    file: 'src/routes/files.ts',
    find: '    const going = [id, ...(await backsGoingWith(db, id))];',
    replace: '    const going = [id];',
    tests: ['tests/e2e/punchboardTokens.test.ts'],
    testName: 'purges a token’s front with the back that was its alone',
  },
  {
    // Copies fill the sheet in the order of the list; a plan that ignored the
    // count would cut one of each.
    name: 'a punchboard cuts every copy a token asks for',
    file: 'src/punchboards.ts',
    find: '    for (let copy = 0; copy < quantity; copy++) {',
    replace: '    for (let copy = 0; copy < Math.min(quantity, 1); copy++) {',
    tests: ['src/punchboards.test.ts'],
    testName: 'packs every copy in rows, in the order of the list',
    runner: 'shared',
  },
];
