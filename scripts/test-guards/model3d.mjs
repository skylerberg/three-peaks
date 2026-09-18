// The studio: geometry built in the browser, and the settings the API stores.

export const guards = [
  {
    name: 'saving 3D settings needs write access, not merely read',
    file: 'src/routes/models.ts',
    find: "    const access = await assertFileAccess(c, fileId, 'write');",
    replace: "    const access = await assertFileAccess(c, fileId, 'read');",
    tests: ['tests/e2e/models.test.ts'],
    testName: 'a viewer is refused with 403',
  },
  {
    name: 'the back face of a card is mirrored',
    file: 'src/lib/model3d/geometry/faceGroups.ts',
    find: '    const u = nz > 0 ? (x - bounds.minX) / width : (bounds.maxX - x) / width;',
    replace: '    const u = (x - bounds.minX) / width;',
    tests: ['src/lib/model3d/geometry/faceGroups.test.ts'],
    testName: 'mirrors the back face across the front',
    runner: 'web',
  },
  {
    name: 'a bevel does not grow the piece past the size it was given',
    file: 'src/lib/model3d/geometry/extrude.ts',
    find: '    bevelOffset: -bevel,',
    replace: '    bevelOffset: 0,',
    tests: ['src/lib/model3d/geometry/faceGroups.test.ts'],
    testName: 'builds a card in metres, straddling the origin',
    runner: 'web',
  },
  {
    // A reorder arranges what a section holds. Without the refusal it is also
    // a way to take a component out of one -- the ids it is not given simply
    // keep whatever position they had, behind rows that now claim theirs.
    name: 'a reorder can neither add a component to a section nor drop one',
    package: 'api',
    file: 'src/routes/components.ts',
    find:
      '      new Set(wanted).size !== wanted.length ||\n' +
      '      wanted.length !== held.length ||\n' +
      '      wanted.some((id) => !holds.has(id))',
    replace: '      false',
    tests: ['tests/e2e/components.test.ts'],
    testName: 'refuses an order with one left out',
  },
  {
    // Most drags end where they started. Writing those renumbers rows that
    // already hold those numbers and announces it to every client with the
    // section open, which is a realtime event per drag that changed nothing.
    name: 'an order that did not move writes nothing and announces nothing',
    package: 'api',
    file: 'src/routes/components.ts',
    find: '      .filter((row) => holds.get(row.id) !== row.position);',
    replace: '      .filter(() => true);',
    tests: ['tests/e2e/realtime.test.ts'],
    testName: 'carries a reordered section, and says nothing when the order did not move',
  },
  {
    // Six faces over one wrap, so a region that overlaps its neighbour is two
    // faces sampling one piece of artwork -- and the box still builds, still
    // textures and still exports, wearing the front panel on its back.
    name: 'no two faces of a box net share a piece of the wrap',
    file: 'packages/shared/src/models3d.ts',
    root: true,
    find: '    back: rect(2 * d + w, d, 2 * d + 2 * w, d + h),',
    replace: '    back: rect(d, d, d + w, d + h),',
    tests: ['src/models3d.test.ts'],
    testName: 'never overlaps two faces',
    runner: 'shared',
  },
];
