// The Blender bundle -- what is picked, what is built, and what the importer is handed.

export const guards = [
  {
    // The importer recomputes the range the same way and would refuse a
    // document whose shots run past it, so a hand-supplied range is a bundle
    // Blender never opens.
    name: 'a scene ends on the last frame its shots reach',
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
    // The floor this replaces was written when a card was in a deck at least
    // once, and it is exactly the line a reader restores on sight. Back in
    // place it puts a card the deck prints none of on the table, and builds and
    // ships a .glb for it.
    name: 'a card the deck holds no copies of stays off the table',
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
    file: 'src/lib/scene/layout.ts',
    find: '    half_width_mm: field.h * FRAMING_MARGIN * reach,',
    replace: '    half_width_mm: field.h * reach,',
    tests: ['src/lib/scene/layout.test.ts'],
    testName: 'fills the frame where the backdrop stands, not merely where the cards do',
    runner: 'web',
  },
  {
    // The one field in the central directory a reader cannot recompute. Every
    // other number in the record repeats one the local header already carries,
    // so a wrong offset is the single way to write an archive that looks
    // complete, unzips without complaint, and hands back the wrong bytes.
    name: 'the central directory points at the local header it names',
    file: 'src/lib/scene/zip.ts',
    find: '    writer.u32(entry.localOffset);',
    replace: '    writer.u32(0);',
    tests: ['src/lib/scene/zip.test.ts'],
    testName: 'keeps every offset straight across an archive of many entries',
    runner: 'web',
  },
];
