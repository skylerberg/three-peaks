// Drives the Blender export screen in a real browser and unpacks the ZIP it
// produces.
//
// Nothing else in the repo can. The planner and the archive writer are both
// unit-tested, but every one of those tests hands buildSceneBundle a stub
// renderer -- there is no WebGL in jsdom and no GLTFExporter without a canvas --
// so the step between "the plan is right" and "an archive Blender opens came
// out" is covered here and nowhere. And the two claims the whole feature rests
// on are facts about that archive rather than about the plan: that a card
// asked for six times is one geometry file inside it, and that each of those
// files measures the millimetres its settings asked for.
//
// The archive is read back from its own central directory, by a reader written
// here rather than borrowed from apps/web. Offsets are the one field a ZIP
// cannot recompute, so a writer checked against its own reader agrees with
// itself about a bug that leaves the file unopenable everywhere else.
//
// It needs an API. Point API_PROXY_TARGET at one (default localhost:17310) and
// it will sign up its own throwaway account.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { createServer } from 'vite';
import {
  SCENE_ASSET_DIR,
  SCENE_FILE_NAME,
  isSceneAssetPath,
  sceneFrameRange,
  validateScene,
} from '@three-peaks/shared';
import { createBrowser } from './lib/browser.mjs';
import { solidPng } from './lib/fixtures.mjs';
import { createProject, inspectApi, probeRefusal, signUp } from './lib/session.mjs';

const PORT = Number(process.env.SCENE_PROBE_PORT ?? 17332);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';
const selftest = process.argv.includes('--selftest');
// Where to unpack the bundle it built, for whoever wants to hand it to the
// other half: `tools/blender/smoke.sh DIR/scene.json` renders this exporter's
// own output instead of the fixture that script writes for itself. Nothing
// here needs Blender, which is why the two are composed by hand.
const keep = process.env.SCENE_KEEP ?? '';

// The deck and settings routes, on top of what inspectApi already requires.
const SCENE_ROUTES = [
  ['post', '/api/decks'],
  ['put', '/api/decks/{deckId}/cards'],
  ['get', '/api/models/{fileId}'],
  ['put', '/api/models/{fileId}'],
];

// Three components, each of which builds its geometry and bakes several
// generated textures into a .glb, on a machine that may have no GPU at all.
const EXPORT_TIMEOUT_MS = 300_000;

const DECK_NAME = 'Trailer deck';
const BOX_NAME = 'Retail box';
const DECK_GROUP = 'deck:trailer-deck';
const CARD_WIDTH_MM = 63;
const CARD_HEIGHT_MM = 88;
// The number the deduplication claim is made about: six pieces, one file.
const COPIES = 6;
const DICE = 2;
const FPS = 24;
const TEMPLATE = 'fan-out';
// Not the default, so a table in the document can only have come from the
// control on the screen.
const FINISH = 'slate';

// Deliberately not the defaults, so what the .glb measures can only have come
// from the row the screen read back rather than from a constant.
const BOX_SETTINGS = {
  kind: 'box',
  width_mm: 120,
  height_mm: 90,
  depth_mm: 60,
  corner_bevel_mm: 1,
  seed: 1,
};

// The longest side each kind should span, in millimetres. glTF's unit is the
// metre, so this is what the accessor bounds have to come to after the
// exporter's one conversion -- a file built unconverted lands a thousand times
// out.
const LONGEST_SIDE_MM = {
  card: Math.max(CARD_WIDTH_MM, CARD_HEIGHT_MM),
  box: Math.max(BOX_SETTINGS.width_mm, BOX_SETTINGS.height_mm, BOX_SETTINGS.depth_mm),
};

const MODELS_404 = /\/api\/models\//;

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
  return condition;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/**
 * Every entry, walked the way a reader walks one: find the end record, read the
 * central directory it points at, and follow each record's offset to the local
 * header it claims is there.
 *
 * Every check on the way is a claim the writer would otherwise be making about
 * itself. The offset is the load-bearing one -- nothing else in a record can be
 * used to find the data, so an archive with the wrong offsets still lists the
 * right names and still reports the right sizes.
 */
function readArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  let end = -1;
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('there is no end-of-central-directory record');

  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryAt = view.getUint32(end + 16, true);

  const entries = [];
  let at = directoryAt;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`central record ${index} does not begin with a record signature`);
    }
    const method = view.getUint16(at + 10, true);
    const checksum = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL_SIGNATURE) {
      throw new Error(`“${name}” is not at offset ${localAt}, where the directory says it is`);
    }
    const localNameLength = view.getUint16(localAt + 26, true);
    const localName = decoder.decode(bytes.subarray(localAt + 30, localAt + 30 + localNameLength));
    if (localName !== name) {
      throw new Error(`the directory calls an entry “${name}”; its header calls it “${localName}”`);
    }

    const dataAt = localAt + 30 + localNameLength + view.getUint16(localAt + 28, true);
    const stored = bytes.subarray(dataAt, dataAt + compressedSize);
    const body = method === 8 ? new Uint8Array(inflateRawSync(stored)) : stored;

    if (body.length !== uncompressedSize) {
      throw new Error(
        `“${name}” unpacks to ${body.length} bytes, not the ${uncompressedSize} claimed`
      );
    }
    if (crc32(body) !== checksum) throw new Error(`“${name}” does not match its checksum`);

    entries.push({ name, bytes: body, method });
    at += 46 + nameLength + extraLength + commentLength;
  }

  if (at !== directoryAt + directorySize) {
    throw new Error(
      `the central directory is ${at - directoryAt} bytes, not the ${directorySize} claimed`
    );
  }
  return entries;
}

// Same reading as check-model3d.mjs, which explains what a GLB header holds.
function inspectGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== 'glTF') return { magic, version: null, json: null };

  const version = view.getUint32(4, true);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/, '')
  );
  return { magic, version, json };
}

/**
 * The widest span of the whole model, in metres, from the min/max glTF requires
 * every POSITION accessor to declare.
 *
 * A node's own translation is added in: a board is a mesh per panel placed by
 * its node, so accessor bounds alone would measure one panel and call it the
 * board.
 */
function modelExtent(json) {
  const placed = new Map();
  for (const node of json?.nodes ?? []) {
    if (node.mesh !== undefined) placed.set(node.mesh, node.translation ?? [0, 0, 0]);
  }

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  (json?.meshes ?? []).forEach((mesh, index) => {
    const offset = placed.get(index) ?? [0, 0, 0];
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        low[axis] = Math.min(low[axis], accessor.min[axis] + offset[axis]);
        high[axis] = Math.max(high[axis], accessor.max[axis] + offset[axis]);
      }
    }
  });

  if (!Number.isFinite(low[0])) return null;
  return Math.max(...high.map((value, axis) => value - low[axis]));
}

const glbAssets = (document) => document.assets.filter((asset) => asset.kind === 'glb');

// Asset paths the document names and the archive does not hold.
function missingFromArchive(document, entries) {
  const held = new Set(entries.map((entry) => entry.name));
  return glbAssets(document)
    .map((asset) => asset.path)
    .filter((path) => !held.has(path));
}

// Entries in the archive no asset accounts for. The other direction, and the
// one that catches a bundle carrying a file per copy.
function unaccountedFor(document, entries) {
  const named = new Set([SCENE_FILE_NAME, ...glbAssets(document).map((asset) => asset.path)]);
  return entries.map((entry) => entry.name).filter((name) => !named.has(name));
}

function instancesPerAsset(document) {
  const counts = new Map();
  for (const instance of document.instances) {
    counts.set(instance.asset_id, (counts.get(instance.asset_id) ?? 0) + 1);
  }
  return counts;
}

async function run() {
  const api = await inspectApi(API, SCENE_ROUTES);
  const refusal = probeRefusal('check:scene', api);
  if (refusal !== null) return refusal;

  const server = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: {
      port: PORT,
      strictPort: false,
      proxy: { '/api': API, '/ws': { target: API, ws: true } },
    },
    logLevel: 'error',
  });
  await server.listen();
  const base = `http://localhost:${server.config.server.port ?? PORT}`;

  const browser = await createBrowser();
  if (!browser) {
    await server.close();
    console.warn('[check:scene] no browser engine available; skipping');
    return 0;
  }

  // An export that throws inside the dynamic import, the renderer or the
  // archive writer rejects a promise the screen turns into a toast that
  // dismisses itself. Without this the only evidence is a wait that expired.
  const pageErrors = [];
  browser.page.on('pageerror', (error) => pageErrors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // A card nobody has dialled in answers 404 on /api/models, which is the
    // planner being told to take the defaults rather than anything going
    // wrong -- and the browser logs a console error for every one of them.
    const from = message.location()?.url ?? '';
    if (MODELS_404.test(from)) return;
    pageErrors.push(from ? `${message.text()} (${from})` : message.text());
  });

  try {
    await signUp(browser, base, { name: 'Scene Probe', stamp: Date.now() });
    await createProject(browser, 'Scene Project');

    // Set up through the API rather than the editor: this probe is about the
    // archive that comes out, and check-upload already drives the real picker.
    const images = Object.fromEntries(
      Object.entries({
        alpha: solidPng({ width: 372, height: 520, rgb: [200, 60, 60] }),
        beta: solidPng({ width: 372, height: 520, rgb: [60, 170, 100] }),
        back: solidPng({ width: 372, height: 520, rgb: [30, 30, 40] }),
        wrap: solidPng({ width: 360, height: 210, rgb: [90, 110, 210] }),
      }).map(([name, bytes]) => [name, [...bytes]])
    );

    const setup = await browser.page.evaluate(
      async (fixture) => {
        const token = localStorage.getItem('tph.token');
        const headers = { Authorization: `Bearer ${token}` };
        const projectId = (await fetch('/api/projects', { headers }).then((r) => r.json()))
          .projects[0].id;

        // The deck first: its cards are uploaded into it, because a deck owns
        // its artwork and an image in Assets is not one of its cards.
        const deck = await fetch('/api/decks', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            name: fixture.deckName,
            card_width_mm: fixture.cardWidthMm,
            card_height_mm: fixture.cardHeightMm,
          }),
        }).then((r) => r.json());

        // The box, named before it has anything in it, the way a component is.
        const box = await fetch('/api/components', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, kind: 'box', name: fixture.boxName }),
        }).then((r) => r.json());

        const into = {
          alpha: { deck_id: deck.id },
          beta: { deck_id: deck.id },
          back: { deck_id: deck.id, role: 'back' },
          wrap: { component_id: box.id, role: 'artwork' },
        };

        const ids = {};
        for (const [name, bytes] of Object.entries(fixture.images)) {
          const query = new URLSearchParams({
            project_id: projectId,
            filename: `${name}.png`,
            ...into[name],
          });
          const created = await fetch(`/api/files/upload?${query}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'image/png' },
            body: new Uint8Array(bytes),
          }).then((r) => r.json());
          ids[name] = created.id;
        }

        await fetch(`/api/decks/${deck.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ back_file_id: ids.back }),
        });

        await fetch(`/api/decks/${deck.id}/cards`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cards: [
              { file_id: ids.alpha, quantity: fixture.copies },
              { file_id: ids.beta, quantity: 1 },
            ],
          }),
        });

        // The one component in the selection anybody has dialled in. The cards
        // are left alone, which is the 404 the planner reads as "the defaults,
        // at the deck's own size".
        const saved = await fetch(`/api/components/${box.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: fixture.box }),
        });

        return { projectId, savedBox: saved.status };
      },
      {
        images,
        deckName: DECK_NAME,
        boxName: BOX_NAME,
        cardWidthMm: CARD_WIDTH_MM,
        cardHeightMm: CARD_HEIGHT_MM,
        copies: COPIES,
        box: BOX_SETTINGS,
      }
    );

    if (!check('the box settings are saved on the component', setup.savedBox === 200)) return 1;

    await browser.goto(`${base}/projects/${setup.projectId}/scene`, { wait: 0 });
    await browser.page.waitForSelector('h1:has-text("Blender scene")', { timeout: 15_000 });
    // The button renders only once the decks and the file tree have answered,
    // so waiting for it is what tells the spinner apart from the pickers.
    await browser.page.waitForSelector('button:has-text("Export bundle")', { timeout: 30_000 });
    check('the export screen opens', true);

    await browser.click(`label:has-text("${DECK_NAME}") input[type="checkbox"]`);
    // By name out of its section: the picker offers components, not the files
    // underneath them.
    await browser.page.waitForSelector(`label:has-text("${BOX_NAME}")`, { timeout: 15_000 });
    await browser.click(`label:has-text("${BOX_NAME}") input[type="checkbox"]`);

    await browser.page.getByLabel('Piece', { exact: true }).selectOption('d6');
    await browser.click('button:has-text("Add piece")');
    await browser.page.getByLabel('How many D6 die').fill(String(DICE));
    await browser.page.getByLabel('How many D6 die').press('Tab');

    await browser.page.getByLabel('Shot', { exact: true }).selectOption(TEMPLATE);
    await browser.page.getByLabel('Table', { exact: true }).selectOption(FINISH);
    await browser.page.getByLabel('Frame rate value').fill(String(FPS));
    await browser.page.getByLabel('Frame rate value').press('Tab');

    // Seven cards, one box and two dice, counted before a byte is built. The
    // one number on this screen that can be checked without the archive.
    const pieces = COPIES + 1 + 1 + DICE;
    const said = await browser.page.textContent('p:has-text("on the table")');
    check(
      'the screen counts every piece before it builds anything',
      new RegExp(`^\\s*${pieces}\\s+pieces on the table`).test(said ?? ''),
      said ?? ''
    );

    const started = Date.now();
    const downloaded = browser.page
      .waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS })
      .then((download) => ({ download }))
      .catch(() => null);
    const complained = browser.page
      .waitForSelector('[role="alert"]', { timeout: EXPORT_TIMEOUT_MS })
      .then(async (node) => ({ said: (await node.textContent())?.trim() ?? '' }))
      .catch(() => null);

    await browser.click('button:has-text("Export bundle")');
    const outcome = (await Promise.race([downloaded, complained])) ?? {};

    if (!outcome.download) {
      check(
        'the bundle is built and handed over',
        false,
        [
          outcome.said && `the app said: ${outcome.said}`,
          browser.serverErrors.length > 0 && `the API answered: ${browser.serverErrors.join(', ')}`,
          pageErrors.length > 0 && `the page threw: ${pageErrors.join(' | ')}`,
        ]
          .filter(Boolean)
          .join('; ') || `nothing was reported in ${EXPORT_TIMEOUT_MS}ms; the export hung`
      );
      return 1;
    }
    console.log(`  ok   the bundle is built and handed over (${Date.now() - started}ms)`);

    check(
      'it is named after the project',
      outcome.download.suggestedFilename() === 'scene-project-scene.zip',
      outcome.download.suggestedFilename()
    );

    const chunks = [];
    for await (const chunk of await outcome.download.createReadStream()) chunks.push(chunk);
    const archive = new Uint8Array(Buffer.concat(chunks));

    let entries;
    try {
      entries = readArchive(archive);
    } catch (error) {
      check('the archive reads back from its own central directory', false, error.message);
      return 1;
    }
    check(`the archive reads back from its own central directory`, true);

    const scene = entries.find((entry) => entry.name === SCENE_FILE_NAME);
    if (!check(`the archive holds ${SCENE_FILE_NAME}`, scene !== undefined)) return 1;
    // Deflated, not stored: JSON shrinks by an order of magnitude and the .glb
    // beside it does not, which is why the writer decides per entry.
    check('the document is compressed and the geometry is not', scene.method === 8);

    let document;
    try {
      document = JSON.parse(new TextDecoder().decode(scene.bytes));
    } catch (error) {
      check(`${SCENE_FILE_NAME} is JSON`, false, error.message);
      return 1;
    }

    // The one assertion that says the importer will open this at all, made with
    // the exporter's own validator rather than a copy of it.
    const issues = validateScene(document);
    check(
      'the document is one the importer would accept',
      issues.length === 0,
      issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    );

    check(
      'every asset it names is in the archive',
      missingFromArchive(document, entries).length === 0,
      missingFromArchive(document, entries).join(', ')
    );
    check(
      'the archive carries nothing the document does not name',
      unaccountedFor(document, entries).length === 0,
      unaccountedFor(document, entries).join(', ')
    );
    check(
      `every asset path sits under ${SCENE_ASSET_DIR}/`,
      glbAssets(document).every((asset) => isSceneAssetPath(asset.path))
    );

    const library = document.assets.filter((asset) => asset.kind === 'library');
    check(
      'a library piece names no file at all, so it costs the bundle no bytes',
      library.length === 1 && library[0].path === undefined,
      `${library.length} library asset(s)`
    );
    check(
      'the archive is the document and one file per component, and nothing else',
      entries.length === glbAssets(document).length + 1,
      `${entries.length} entries for ${glbAssets(document).length} components`
    );

    const counts = instancesPerAsset(document);
    const deckInstances = document.instances.filter((row) => row.group === DECK_GROUP);
    const deckAssets = new Set(deckInstances.map((row) => row.asset_id));
    check(
      `the deck's ${COPIES + 1} cards are ${COPIES + 1} pieces over two geometry files`,
      deckInstances.length === COPIES + 1 && deckAssets.size === 2,
      `${deckInstances.length} pieces, ${deckAssets.size} files`
    );
    check(
      `the card asked for ${COPIES} times names one file, not ${COPIES}`,
      [...deckAssets].filter((id) => counts.get(id) === COPIES).length === 1,
      [...deckAssets].map((id) => `${id}x${counts.get(id)}`).join(', ')
    );
    check(
      'two dice are two pieces of one asset',
      [...counts.values()].filter((count) => count === DICE).length === 1
    );

    // The reason the whole feature has a unit at all. Each file is opened, its
    // accessors read, and the span compared against the millimetres its
    // settings asked for -- a component exported unconverted is a thousand
    // times out and lands in Blender the size of a building.
    for (const asset of glbAssets(document)) {
      const entry = entries.find((row) => row.name === asset.path);
      const glb = inspectGlb(entry.bytes);
      check(`${asset.path} is a glTF 2 container`, glb.magic === 'glTF' && glb.version === 2);
      check(`${asset.path} embeds its textures`, (glb.json?.images?.length ?? 0) > 0);

      const wanted = LONGEST_SIDE_MM[asset.component] / 1000;
      const extent = modelExtent(glb.json);
      check(
        `${asset.path} measures its longest side in metres`,
        extent !== null && Math.abs(extent - wanted) < 0.0005,
        `${extent} m across, expected ${wanted}`
      );
    }

    if (keep) {
      for (const entry of entries) {
        const path = join(keep, entry.name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entry.bytes);
      }
      console.log(`  ..   unpacked into ${keep}`);
    }

    // The table is the one thing in the document that is neither an asset nor an
    // instance, and the archive is where that can actually be seen: it changes
    // what the render stands on and costs the bundle no bytes doing it.
    check(
      'the table finish picked on the screen is the one it wrote',
      document.surface?.finish === FINISH,
      JSON.stringify(document.surface)
    );
    check(
      'the table is scenery: no asset, no instance, no file in the archive',
      document.assets.every((asset) => asset.label !== 'Table') &&
        document.instances.every((row) => row.label !== 'Table') &&
        entries.every((entry) => !entry.name.toLowerCase().includes('table')),
      `${document.assets.length} assets, ${entries.length} entries`
    );
    check(
      'the table is cut larger than the cards standing on it',
      (document.surface?.width_mm ?? 0) > CARD_WIDTH_MM &&
        (document.surface?.depth_mm ?? 0) > CARD_HEIGHT_MM,
      `${document.surface?.width_mm} x ${document.surface?.depth_mm} mm`
    );

    // The frame rate is the one render setting that changes the numbers rather
    // than the picture, because a keyframe is written at a frame.
    check('the frame rate chosen on the screen is the one it wrote', document.render.fps === FPS);
    check(
      'the timeline ends on the last frame the shots reach',
      document.render.frame_range[1] ===
        sceneFrameRange(document.shots, document.instances, FPS)[1],
      `${document.render.frame_range[1]}`
    );
    // One fan, aimed at the deck. The box and the dice are picked in the same
    // selection and deliberately stay where they are: a fan collapses whatever
    // it is aimed at onto one small arc, which for a deck is a hand of cards
    // and for a box and a die is a pile.
    check(
      'the template picked on the screen fans the deck and leaves the rest standing',
      document.shots.length === 1 &&
        document.shots[0].kind === 'fan' &&
        document.shots[0].target === DECK_GROUP,
      document.shots.map((shot) => `${shot.kind}->${shot.target}`).join(', ')
    );

    if (pageErrors.length > 0) {
      check('the page threw nothing while building the bundle', false, pageErrors.join(' | '));
    }

    if (selftest) {
      // Sensitivity. Every assertion above reads a real archive, and one that
      // read the wrong thing would pass exactly like one that read the right
      // thing -- so each of the three claims is run again against a bundle put
      // back on the bug it exists to catch.
      console.log('\n[selftest] the same assertions against a bundle put back on its bug:');

      // A central directory that names the right entries at the wrong places.
      // Nothing about the listing changes; only the offsets do, which is the
      // whole reason this reader follows them.
      const moved = Uint8Array.from(archive);
      const view = new DataView(moved.buffer);
      for (let at = moved.length - 22; at >= 0; at -= 1) {
        if (view.getUint32(at, true) === EOCD_SIGNATURE) {
          view.setUint32(view.getUint32(at + 16, true) + 42, 1, true);
          break;
        }
      }
      let caught = null;
      try {
        readArchive(moved);
      } catch (error) {
        caught = error.message;
      }
      if (caught === null) {
        console.error('[selftest] FAILED: an archive with a wrong offset was read happily');
        return 1;
      }
      console.log(`  ok   an entry at the wrong offset is rejected (${caught})`);

      // A bundle carrying a file per copy rather than per component: the
      // document names six paths where it named one, and the archive holds
      // them.
      const perCopy = JSON.parse(JSON.stringify(document));
      const repeated = [...counts.entries()].find(([, count]) => count === COPIES)[0];
      const template = perCopy.assets.find((asset) => asset.id === repeated);
      perCopy.instances
        .filter((instance) => instance.asset_id === repeated)
        .forEach((instance, index) => {
          const id = `${repeated}-copy-${index + 1}`;
          instance.asset_id = id;
          perCopy.assets.push({ ...template, id, path: `${SCENE_ASSET_DIR}/${id}.glb` });
        });
      const spread = instancesPerAsset(perCopy);
      if ([...spread.values()].some((count) => count === COPIES)) {
        console.error('[selftest] FAILED: a file per copy still looked like a shared file');
        return 1;
      }
      if (missingFromArchive(perCopy, entries).length !== COPIES) {
        console.error('[selftest] FAILED: files the archive does not hold were not reported');
        return 1;
      }
      console.log('  ok   a geometry per copy is reported, and its files are missing');

      // A component built in millimetres and exported unconverted. The file is
      // a perfectly good glTF; it is only a thousand times too big.
      const unconverted = JSON.parse(
        JSON.stringify(inspectGlb(entries.find((row) => row.name.endsWith('.glb')).bytes).json)
      );
      for (const accessor of unconverted.accessors ?? []) {
        if (accessor.min?.length === 3) accessor.min = accessor.min.map((v) => v * 1000);
        if (accessor.max?.length === 3) accessor.max = accessor.max.map((v) => v * 1000);
      }
      const blown = modelExtent(unconverted);
      if (Math.abs(blown - LONGEST_SIDE_MM.card / 1000) < 0.0005) {
        console.error('[selftest] FAILED: a model left in millimetres still measured metres');
        return 1;
      }
      console.log(`  ok   a model left in millimetres is rejected (${blown} m across)`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\ncheck:scene passed');
  return 0;
}

process.exit(await run());
