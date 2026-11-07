// Card layouts -- what the API accepts as one, and the CLI that renders cards
// from them.

export const guards = [
  {
    // The determinism every comparison of checksums rests on. A <text> element
    // is drawn in whatever font the rasteriser finds, which is the one thing
    // two machines are free to disagree about.
    name: 'card copy is written as glyph paths, never as SVG text',
    root: true,
    file: 'apps/cli/src/layout/svg.ts',
    find: '      paths.push(font.getPath(item.text, item.x, item.baseline, item.size).toPathData(4));',
    replace:
      '      icons.push(`<text x="${n(item.x)}" y="${n(item.baseline)}" font-size="${n(item.size)}">${item.text}</text>`);',
    tests: ['../cli/tests/unit/layoutRender.test.ts'],
    testName: 'writes copy as paths and never as text',
  },
  {
    // Without it a render is either drawn always or never, and the badge on
    // the cards with a cost appears on all of them.
    name: 'an element is drawn only when its `when` field has a value',
    root: true,
    file: 'apps/cli/src/layout/svg.ts',
    find: '    if (element.when !== null && !hasValue(fields, element.when)) return;',
    replace: '',
    tests: ['../cli/tests/unit/layoutRender.test.ts'],
    testName: 'leaves out an element whose `when` field is empty',
  },
  {
    // Uploading whatever was rendered would still be correct -- the server
    // appends nothing for identical bytes -- but every push would then be a
    // transfer per card and a report of every card as updated.
    name: 'a pushed card whose image comes out the same is not uploaded',
    root: true,
    file: 'apps/cli/src/layouts.ts',
    find: '      const imageChanged = sha256(bytes) !== existing.file.checksum;',
    replace: '      const imageChanged = true;',
    tests: ['../cli/tests/e2e/layout.test.ts'],
    testName: 'changes nothing when the file has not changed',
  },
  {
    // The same comparison on the re-render path, where it is also what --check
    // answers with.
    name: 'a re-rendered card whose image comes out the same is not reported stale',
    root: true,
    file: 'apps/cli/src/layouts.ts',
    find: "      if (sha256(bytes) === card.file.checksum) return { ...base, outcome: 'unchanged' };\n",
    replace: '',
    tests: ['../cli/tests/e2e/layout.test.ts'],
    testName: 'says which cards a new version of their art left out of date',
  },
  {
    // The project filter is what makes "a file in the same project" true. Left
    // out, a card can name artwork in a project its editor cannot see, and the
    // renderer will happily download it for them.
    name: "a card's image must be a file in the card's own project",
    file: 'src/services/cardLayouts.ts',
    find: "    .where('file.project_id', '=', projectId)\n    .execute();\n  return new Map(",
    replace: '    .execute();\n  return new Map(',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: "refuses another project's image, and a file that is no picture",
  },
  {
    // A layout on a card of the wrong size renders without complaint and
    // prints at the wrong scale; this is the first place that can say so.
    name: "card content is refused for a layout of a different size from the deck's",
    file: 'src/routes/cardContent.ts',
    find: '    if (deckSize !== layoutSize) {',
    replace: '    if (false) {',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: 'refuses a layout drawn on a card of another size',
  },
  {
    // `spec.fields.toString` is a function, not undefined, so a card could
    // otherwise store a field the layout never declared.
    name: "a card's field must be one the layout declares itself",
    file: 'src/layouts.ts',
    find: '    if (field === undefined || !Object.hasOwn(spec.fields, key)) {',
    replace: '    if (field === undefined) {',
    tests: ['src/layouts.test.ts'],
    testName: 'is not fooled by a key inherited from Object',
    runner: 'shared',
  },
];
