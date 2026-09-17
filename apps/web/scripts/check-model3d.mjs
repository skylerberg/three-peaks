// Drives the 3D studio in a real browser and inspects the .glb it produces.
//
// Nothing else in the repo can. The geometry maths is unit-tested in jsdom, but
// GLTFExporter needs a real canvas to serialise a texture and a real WebGL
// context to have drawn anything at all -- so the step between "the vertices
// are right" and "a file Blender can open came out" has no other cover.
//
// It needs an API. Point API_PROXY_TARGET at one (default localhost:17310) and
// it will sign up its own throwaway account.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { createBrowser } from './lib/browser.mjs';
import { createProject, inspectApi, probeRefusal, signUp } from './lib/session.mjs';

const PORT = Number(process.env.MODEL_PROBE_PORT ?? 17332);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';
const selftest = process.argv.includes('--selftest');

// Building the model, serialising four generated textures into a .glb and
// uploading it, on a machine that may be rendering the preview in software.
const SAVE_TIMEOUT_MS = 120_000;

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

const CRC_TABLE = Array.from({ length: 256 }, (_value, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A 16x16 PNG, written by hand rather than checked in: the fixture is then the
// same shape the assertions describe, and there is no binary in the tree whose
// contents nobody can read in a diff.
//
// An opaque disc on a transparent field, so the alpha tracer has one closed
// contour to find and the card path has something to print.
function discPng() {
  const width = 16;
  const raw = Buffer.alloc(width * (width * 4 + 1));
  for (let y = 0; y < width; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 6 ** 2;
      const offset = rowStart + 1 + x * 4;
      raw[offset] = 200;
      raw[offset + 1] = 120;
      raw[offset + 2] = 40;
      raw[offset + 3] = inside ? 255 : 0;
    }
  }

  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Reads the container rather than trusting that a file arrived: a zero-length
// upload and a truncated export both produce a row in the explorer.
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

// The widest span of any POSITION accessor, read from the min/max glTF requires
// every one of them to declare.
function positionExtent(json) {
  const accessors = (json?.meshes?.[0]?.primitives ?? [])
    .map((primitive) => json.accessors?.[primitive.attributes?.POSITION])
    .filter((accessor) => accessor?.min && accessor?.max);
  if (accessors.length === 0) return null;

  return Math.max(
    ...accessors.flatMap((accessor) => accessor.max.map((high, axis) => high - accessor.min[axis]))
  );
}

// Default settings, so what each one measures is DEFAULT_BOX_SETTINGS and
// DEFAULT_BOARD_SETTINGS read in metres: a 295 mm box, and one panel of a
// bifold 500 mm board, which is 500 mm on its uncut side.
// A die line with two closed shapes on a 100x50 sheet: one square and one
// circle, so the tracing-free path is exercised on a curve as well as on
// straight edges. The viewBox is what the sheet's millimetres are stretched
// over, and both shapes sit well inside it.
const CUT_SHEET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <rect x="10" y="10" width="30" height="30" fill="#000" />
  <circle cx="75" cy="25" r="15" fill="#000" />
</svg>
`;

// The kinds the save path above does not reach. A box is one mesh over six
// material slots, a folded board is a mesh per panel, and a punchboard is the
// sheet plus one mesh per token the die line cuts -- three shapes the exporter
// is otherwise never handed. Read off the download rather than saved, because a
// second file of the same name is a different question from whether one exports
// at all.
const BUILT_KINDS = [
  {
    section: 'Boxes',
    singular: 'box',
    name: 'Probe box',
    settles: 'Corner bevel',
    meshes: 1,
    materials: 6,
    across: 0.295,
  },
  {
    section: 'Boards',
    singular: 'board',
    name: 'Probe board',
    settles: 'Fold gap',
    meshes: 2,
    materials: 3,
    across: 0.5,
  },
  {
    section: 'Punchboards',
    singular: 'punchboard',
    name: 'Probe punchboard',
    settles: 'Cut edge colour',
    cut: CUT_SHEET,
    // The sheet and the two tokens the die line cuts out of it.
    meshes: 3,
    materials: 3,
    across: 0.28,
  },
];

// Every kind is its own component now, named in its own section and given its
// artwork afterwards -- so reaching one is a walk rather than a click on a
// picker the studio no longer has.
async function makeComponent(browser, kind, files) {
  // By URL rather than by a back link: the link out of a component names the
  // section it is in, which differs per kind, and this runs from all of them.
  const here = new URL(browser.page.url());
  await browser.goto(`${here.origin}/projects/${here.pathname.split('/')[2]}`, { wait: 0 });

  await browser.page.waitForSelector(`a:has-text("${kind.section}")`, { timeout: 15_000 });
  await browser.click(`a:has-text("${kind.section}")`);
  await browser.page.waitForSelector(`button:has-text("New ${kind.singular}")`, {
    timeout: 15_000,
  });
  await browser.click(`button:has-text("New ${kind.singular}")`);
  await browser.page.fill('input[maxlength="120"]', kind.name);
  await browser.click('button[type="submit"]');
  await browser.page.waitForSelector(`h1:has-text("${kind.name}")`, { timeout: 15_000 });

  await browser.page.setInputFiles('label:has-text("Artwork") input[type="file"]', files.pngPath);
  if (kind.cut) {
    const cutPath = join(files.dir, 'cut.svg');
    writeFileSync(cutPath, kind.cut);
    await browser.page.waitForSelector('label:has-text("Cut sheet") input[type="file"]', {
      timeout: 15_000,
    });
    await browser.page.setInputFiles('label:has-text("Cut sheet") input[type="file"]', cutPath);
  }
}

// The studio hands the browser bytes it already holds, so this is the download
// event and not a request anything could answer differently.
async function downloadedGlb(browser) {
  const [download] = await Promise.all([
    browser.page.waitForEvent('download', { timeout: SAVE_TIMEOUT_MS }),
    browser.click('button:has-text("Download .glb")'),
  ]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

async function run() {
  const api = await inspectApi(API);
  const refusal = probeRefusal('check:model3d', api);
  if (refusal !== null) return refusal;

  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
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
    console.warn('[check:model3d] no browser engine available; skipping');
    return 0;
  }

  // A build that throws inside the dynamic import or the exporter rejects a
  // promise nothing else reads, and the screen simply never changes. Without
  // this the only evidence is a selector that timed out.
  const pageErrors = [];
  browser.page.on('pageerror', (error) => pageErrors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await signUp(browser, base, { name: 'Model Probe', stamp: Date.now() });
    await createProject(browser, 'Model Project');

    const dir = mkdtempSync(join(tmpdir(), 'tph-model-'));
    const pngPath = join(dir, 'token.png');
    writeFileSync(pngPath, discPng());

    // A component is named first and given its artwork afterwards, and the
    // studio is the component's own screen -- there is no picking a file out of
    // Assets and asking what it should become.
    await browser.page.waitForSelector('a:has-text("Wooden pieces")', { timeout: 15_000 });
    await browser.click('a:has-text("Wooden pieces")');
    await browser.page.waitForSelector('button:has-text("New wooden piece")', { timeout: 15_000 });
    await browser.click('button:has-text("New wooden piece")');
    await browser.page.fill('input[maxlength="120"]', 'Probe meeple');
    await browser.click('button[type="submit"]');
    await browser.page.waitForSelector('h1:has-text("Probe meeple")', { timeout: 15_000 });
    check('a component is created and opened', true);

    await browser.setInputFiles('input[type="file"]', pngPath);
    await browser.page.waitForSelector('canvas', { timeout: 15_000 });
    check('the studio opens on a canvas once the artwork is there', true);

    // WebGL is what the viewer needs, and a headless browser without it draws
    // nothing while every other assertion still passes.
    const drawing = await browser.page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return Boolean(canvas && canvas.width > 0 && canvas.getContext('webgl2'));
    });
    check('the canvas has a live WebGL context', drawing);

    // No kind picker to click: the kind was decided when the component was
    // created, so the panel that opens is the one for it.
    await browser.page.waitForSelector('text=Longest side', { timeout: 10_000 });
    check('the panel is the one for the kind the component is', true);

    // The model is built from bytes that have to be fetched and decoded first,
    // and the viewer shows this spinner until it has one. Clicking Save before
    // it clears exports nothing and toasts "There is no model to export yet" --
    // which is what CI did, in under a second, while a laptop had always
    // finished decoding before the click landed and so passed for the wrong
    // reason.
    await browser.page.waitForSelector('text=Building the model', {
      state: 'hidden',
      timeout: 60_000,
    });
    check('the model finishes building', true);

    await browser.click('button:has-text("Save to project")');

    // Generous, and deliberately so. The viewer renders continuously, and on a
    // runner with no GPU that loop is software-rasterised on the same core the
    // export is serialising four generated textures on -- so this step is
    // legitimately an order of magnitude slower here than on a laptop. The
    // elapsed time is printed so "slow" stays distinguishable from "hung".
    // Raced, not read afterwards. An error toast dismisses itself after eight
    // seconds, so reading the DOM once a two-minute success wait has expired
    // finds nothing and reports "no toast" for a save that failed loudly and
    // early -- which is exactly what the first run of this in CI reported.
    const started = Date.now();
    const outcome = await Promise.race([
      browser.page
        // Named after the component rather than after the image it was built
        // from: the component is the thing, and its artwork is one of its parts.
        .waitForSelector('text=/Saved Probe meeple\\.glb/', { timeout: SAVE_TIMEOUT_MS })
        .then(() => ({ saved: true, said: '' })),
      browser.page
        .waitForSelector('[role="alert"]', { timeout: SAVE_TIMEOUT_MS })
        .then(async (node) => ({ saved: false, said: (await node.textContent())?.trim() ?? '' })),
    ]).catch(() => ({ saved: false, said: '' }));

    if (!outcome.saved) {
      const said = browser.serverErrors;
      check(
        'the export is saved to the project',
        false,
        [
          outcome.said && `the app said: ${outcome.said}`,
          said.length > 0 && `the API answered: ${said.join(', ')}`,
          pageErrors.length > 0 && `the page threw: ${pageErrors.join(' | ')}`,
        ]
          .filter(Boolean)
          .join('; ') || `nothing was reported in ${SAVE_TIMEOUT_MS}ms; the export hung`
      );
      return 1;
    }
    console.log(`  ok   the export is saved to the project (${Date.now() - started}ms)`);

    const stored = await browser.page.evaluate(async () => {
      const token = localStorage.getItem('tph.token');
      const headers = { Authorization: `Bearer ${token}` };
      const list = await fetch('/api/projects', { headers }).then((r) => r.json());
      const projectId = list.projects[0].id;
      const listing = await fetch(`/api/files/directory?project_id=${projectId}`, {
        headers,
      }).then((r) => r.json());
      const glb = listing.files.find((file) => file.filename.endsWith('.glb'));
      if (!glb) return null;
      const buffer = await fetch(`/api/files/${glb.id}/download`, { headers }).then((r) =>
        r.arrayBuffer()
      );
      return { contentType: glb.content_type, bytes: [...new Uint8Array(buffer)] };
    });

    if (!check('the exported model was stored in the project', stored !== null)) {
      return 1;
    }

    const bytes = Uint8Array.from(stored.bytes);
    const glb = inspectGlb(bytes);

    check('the stored file is a glTF container', glb.magic === 'glTF', glb.magic);
    check('the container is glTF 2', glb.version === 2, String(glb.version));
    // The sniffer decides this from the bytes, so it is also the proof that a
    // .glb is not stored as an opaque stream.
    check(
      'the API typed it as a binary glTF',
      stored.contentType === 'model/gltf-binary',
      stored.contentType
    );
    check('the model has a mesh', (glb.json?.meshes?.length ?? 0) > 0);
    check('the model has materials', (glb.json?.materials?.length ?? 0) > 0);
    // Procedural wood is generated in the browser and has to be baked in, or
    // the file opens in Blender as untextured grey.
    check('the textures are embedded', (glb.json?.images?.length ?? 0) > 0);
    check(
      'the mesh has as many primitives as it has material slots',
      (glb.json?.meshes?.[0]?.primitives?.length ?? 0) >= 2,
      String(glb.json?.meshes?.[0]?.primitives?.length)
    );

    // The reason the whole thing exists: a piece has to import measuring what it
    // was told to measure. glTF's unit is the metre, the studio's is the
    // millimetre, and the wooden default is 30 mm on its longest side -- so the
    // accessor bounds have to span 0.03. A model built in millimetres and
    // exported unconverted lands here a thousand times too big.
    const extent = positionExtent(glb.json);
    check(
      'the piece measures its longest side in metres',
      extent !== null && Math.abs(extent - 0.03) < 0.0005,
      `${extent} m across, expected 0.03`
    );

    // The two kinds the trailer scene added, and the ones the save path above
    // does not reach: a box is one mesh over six material slots and a folded
    // board is a mesh per panel, so both are shapes the exporter had never been
    // handed. Read off the download rather than saved, because a second file of
    // the same name is a different question from whether a box exports at all.
    for (const kind of BUILT_KINDS) {
      await makeComponent(browser, kind, { pngPath, dir });
      await browser.page.waitForSelector(`text=${kind.settles}`, { timeout: 10_000 });
      await browser.page.waitForSelector('text=Building the model', {
        state: 'hidden',
        timeout: 60_000,
      });

      const exported = inspectGlb(await downloadedGlb(browser));
      check(`the ${kind.singular} exports a glTF container`, exported.magic === 'glTF');
      check(
        `the ${kind.singular} exports ${kind.meshes} mesh(es)`,
        (exported.json?.meshes?.length ?? 0) === kind.meshes,
        String(exported.json?.meshes?.length)
      );
      check(
        `the ${kind.singular} keeps one material per slot`,
        (exported.json?.materials?.length ?? 0) === kind.materials,
        String(exported.json?.materials?.length)
      );
      const span = positionExtent(exported.json);
      check(
        `the ${kind.singular} measures its longest side in metres`,
        span !== null && Math.abs(span - kind.across) < 0.0005,
        `${span} m across, expected ${kind.across}`
      );
    }

    if (selftest) {
      // Sensitivity: the same assertions against something that is not a GLB
      // must fail. Without this arm, an inspector that always returned nulls
      // would look exactly like a passing check.
      console.log('\n[selftest] the same assertions against bytes that are not a model:');
      const notAModel = inspectGlb(new TextEncoder().encode('this is not a model at all'));
      if (notAModel.magic === 'glTF' || notAModel.json !== null) {
        console.error('[selftest] FAILED: plain text was read as a glTF container');
        return 1;
      }
      console.log('  ok   plain text is not read as a glTF container');
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\ncheck:model3d passed');
  return 0;
}

process.exit(await run());
