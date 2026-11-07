// Card layouts -- what the API accepts as one, how it draws cards from them,
// and the CLI that asks it to.

export const guards = [
  {
    // The determinism every comparison of checksums rests on. A <text> element
    // is drawn in whatever font the rasteriser finds, which is the one thing
    // two machines are free to disagree about.
    name: 'card copy is written as glyph paths, never as SVG text',
    file: 'src/services/cardRender/svg.ts',
    find: '      paths.push(font.getPath(item.text, item.x, item.baseline, item.size).toPathData(4));',
    replace:
      '      icons.push(`<text x="${n(item.x)}" y="${n(item.baseline)}" font-size="${n(item.size)}">${item.text}</text>`);',
    tests: ['tests/unit/cardRender/layoutRender.test.ts'],
    testName: 'writes copy as paths and never as text',
  },
  {
    // Without it a render is either drawn always or never, and the badge on
    // the cards with a cost appears on all of them.
    name: 'an element is drawn only when its `when` field has a value',
    file: 'src/services/cardRender/svg.ts',
    find: '    if (element.when !== null && !hasValue(fields, element.when)) return null;',
    replace: '',
    tests: ['tests/unit/cardRender/layoutRender.test.ts'],
    testName: 'leaves out an element whose `when` field is empty',
  },
  {
    // A card drawn again that came out as it was is what `deck render` reports
    // as unchanged; without the comparison every card reads as updated.
    name: 'a card drawn again that came out the same is reported unchanged',
    root: true,
    file: 'apps/cli/src/layouts.ts',
    find: "outcome: checksum === target.card.file.checksum ? 'unchanged' : 'versioned',",
    replace: "outcome: 'versioned',",
    tests: ['../cli/tests/e2e/layout.test.ts'],
    testName: 'says which cards a new version of their art is waiting on',
  },
  {
    // Without it a layout saves and its cards keep the picture of the old one,
    // with nothing saying they are behind.
    name: 'a change to a layout asks for its cards to be drawn again',
    file: 'src/routes/cardLayouts.ts',
    find: '    if (!drawsAlike) await requestLayoutRenders(c, layoutId);',
    replace: '',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: 'draws the cards again in the background when their layout changes',
  },
  {
    // The same for a font, an icon, a frame or art: every version is written
    // through appendFileVersion, so this one line covers every way to make one.
    name: 'a new version of a file asks for the cards drawing it to be drawn again',
    file: 'src/services/files.ts',
    find: '  await requestRendersOfFile(c, file.project_id, fileId);',
    replace: '',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: 'draws the cards again when a file they draw gets a version',
  },
  {
    // A card drawing a laid-out card is drawn again whenever that one is, and a
    // card drawing itself is drawn again forever.
    name: 'a laid-out card cannot be drawn into another',
    file: 'src/services/cardLayouts.ts',
    find: '  if (file.drawn) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: 'will not draw a laid-out card into another',
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
    file: 'src/services/cardImages.ts',
    find: '  if (layout.width_mm !== deck.width_mm || layout.height_mm !== deck.height_mm) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/cardLayouts.test.ts'],
    testName: 'refuses a layout drawn on a card of another size',
  },
  {
    // Copy that came out empty has no edge to pin to. Following the pin
    // anyway draws the backing behind nothing, at a size worked out from NaN.
    name: 'an element pinned to one that drew nothing is left out too',
    file: 'src/services/cardRender/svg.ts',
    find: '      if (pinned === null) return null;',
    replace: '      if (pinned === null) continue;',
    tests: ['tests/unit/cardRender/layoutRender.test.ts'],
    testName: 'leaves out an element pinned to one that drew nothing',
  },
  {
    // Without it a hugging name measures as its whole box, and the backing
    // pinned to it is as long for one letter as for twenty.
    name: 'copy that hugs measures as what it set, not as its box',
    file: 'src/services/cardRender/svg.ts',
    find: '    const used = element.hug ? turned(text.flow.bounds, frame, element.rotate) : frame;',
    replace: '    const used = frame;',
    tests: ['tests/unit/cardRender/layoutRender.test.ts'],
    testName: 'pins a backing to the copy it sits behind, however long the copy',
  },
  {
    // Two pieces of a sliced image that merely meet each cover half of the
    // pixel their edge crosses, and the card shows through the seam.
    name: "a nine-slice image's pieces overlap by a pixel",
    file: 'src/services/cardRender/svg.ts',
    find: '  const reach = canvas.pixel;',
    replace: '  const reach = 0;',
    tests: ['tests/unit/cardRender/layoutRender.test.ts'],
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
