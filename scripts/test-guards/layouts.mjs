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
    find: '    if (element.when !== null && !hasValue(fields, element.when)) return null;',
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
    // Copy that came out empty has no edge to pin to. Following the pin
    // anyway draws the backing behind nothing, at a size worked out from NaN.
    name: 'an element pinned to one that drew nothing is left out too',
    root: true,
    file: 'apps/cli/src/layout/svg.ts',
    find: '      if (pinned === null) return null;',
    replace: '      if (pinned === null) continue;',
    tests: ['../cli/tests/unit/layoutRender.test.ts'],
    testName: 'leaves out an element pinned to one that drew nothing',
  },
  {
    // Without it a hugging name measures as its whole box, and the backing
    // pinned to it is as long for one letter as for twenty.
    name: 'copy that hugs measures as what it set, not as its box',
    root: true,
    file: 'apps/cli/src/layout/svg.ts',
    find: '    const used = element.hug ? turned(text.flow.bounds, frame, element.rotate) : frame;',
    replace: '    const used = frame;',
    tests: ['../cli/tests/unit/layoutRender.test.ts'],
    testName: 'pins a backing to the copy it sits behind, however long the copy',
  },
  {
    // Two pieces of a sliced image that merely meet each cover half of the
    // pixel their edge crosses, and the card shows through the seam.
    name: "a nine-slice image's pieces overlap by a pixel",
    root: true,
    file: 'apps/cli/src/layout/svg.ts',
    find: '  const reach = canvas.pixel;',
    replace: '  const reach = 0;',
    tests: ['../cli/tests/unit/layoutRender.test.ts'],
    testName: 'joins its pieces with no seam',
  },
  {
    // A circle of pins is refused when the layout is pushed; the renderer's
    // own check would otherwise be the first to say so, card by card.
    name: 'a layout whose edges are pinned in a circle is refused',
    file: 'src/layouts.ts',
    find: '  if (cycle !== null)\n    errors.push(',
    replace: '  if (false)\n    errors.push(',
    tests: ['src/layouts.test.ts'],
    testName: 'names the elements going round a circle of pins',
    runner: 'shared',
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
