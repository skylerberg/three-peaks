// Drives the print builder in a real browser and reads the PDF it produces.
//
// Nothing else in the repo can. The sheet arithmetic is unit-tested in node, but
// the step between "the slot coordinates are right" and "a file a printer lays
// down correctly came out" runs through a canvas, an image decoder and a PDF
// writer that only exist in a browser -- and the one thing that has to be true
// of the result, that every card's own back sits behind it the right way up
// after the paper is flipped, is a fact about coordinates inside the finished
// file. Minis are in the run because the planner lays them on their side, and
// a sideways card is drawn through a rotation the upright ones never exercise.
//
// It needs an API. Point API_PROXY_TARGET at one (default localhost:17310) and
// it will sign up its own throwaway account.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { createBrowser } from './lib/browser.mjs';
import { solidPng } from './lib/fixtures.mjs';
import { createProject, inspectApi, probeRefusal, signUp } from './lib/session.mjs';

const PORT = Number(process.env.PRINT_PROBE_PORT ?? 17331);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';
const selftest = process.argv.includes('--selftest');
// Set on the child the selection arm spawns, so its own --selftest cannot
// recurse into another one.
const MUTATED = 'PRINT_PROBE_MUTATED';

// US Letter in PDF points, which is the unit a MediaBox is written in.
const LETTER_WIDTH_PT = 612;
const LETTER_HEIGHT_PT = 792;
const MM_PER_PT = 25.4 / 72;

// Poker cards on Letter inside the default printer margin, and minis, which are
// turned to fit. Kept here rather than derived, so the probe fails if the
// packing quietly changes.
const POKER_PER_SHEET = 9;
const POKER_COLUMNS = 3;
const MINI_PER_SHEET = 18;

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

const IDENTITY = [1, 0, 0, 1, 0, 0];

// PDF matrices, `[a b c d e f]` mapping (x, y) to (ax + cy + e, bx + dy + f).
// A `cm` operator applies its matrix before whatever is already in force, so the
// one written last is the first a point meets.
function compose(outer, inner) {
  const [a1, b1, c1, d1, e1, f1] = inner;
  const [a2, b2, c2, d2, e2, f2] = outer;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ];
}

function apply([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

// The box an image XObject paints, given the matrix in force when it is drawn:
// the unit square, transformed. `up` is the compass point the artwork's own top
// edge points at on the page, which is what tells a card on its side from one
// drawn upright and clipped, and a back turned the wrong way from its front.
function describeImage(ctm, image) {
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => apply(ctm, u, v));
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const [upX, upY] = [ctm[2], ctm[3]];

  return {
    image,
    x: Math.min(...xs),
    // Flipped to a top-left origin, which is what the layout code works in and
    // therefore what the assertions below can be written against.
    y: LETTER_HEIGHT_PT - Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    up: Math.abs(upX) > Math.abs(upY) ? (upX > 0 ? 'E' : 'W') : upY > 0 ? 'N' : 'S',
  };
}

/**
 * Every image placement in one content stream.
 *
 * jsPDF writes an upright image as `q <w> 0 0 <h> <x> <y> cm /I<n> Do Q`, and a
 * turned one as three `cm` operators -- a translation to the pivot, the
 * rotation, and the scale -- so the stream is walked rather than matched:
 * `q` and `Q` push and pop the matrix, `cm` composes onto it, and `Do` records
 * what is in force. Reading that back is the only way to assert where a card
 * actually landed and which way it faces; a screenshot cannot tell a correctly
 * mirrored back page from an incorrect one.
 */
function readStream(text) {
  const placements = [];
  const saved = [];
  let ctm = IDENTITY;
  let operands = [];
  let name = null;

  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    if (/^-?[\d.]+$/.test(token)) {
      operands.push(Number(token));
      continue;
    }
    if (token.startsWith('/')) {
      name = token.slice(1);
      continue;
    }

    if (token === 'q') saved.push(ctm);
    else if (token === 'Q') ctm = saved.pop() ?? IDENTITY;
    else if (token === 'cm' && operands.length >= 6) ctm = compose(ctm, operands.slice(-6));
    else if (token === 'Do' && name !== null) placements.push(describeImage(ctm, name));
    operands = [];
  }

  return placements;
}

// Every image placement in the document, page by page.
function readPlacements(bytes) {
  const latin = Buffer.from(bytes).toString('latin1');
  const pages = [];

  const streams = /stream\r?\n/g;
  let match;
  while ((match = streams.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;

    const body = Buffer.from(bytes).subarray(start, end);
    let text;
    try {
      text = inflateSync(body).toString('latin1');
    } catch {
      // Not a Flate stream: an embedded JPEG, or the image data itself.
      continue;
    }
    if (!/\bDo\b/.test(text)) continue;

    pages.push(readStream(text));
  }

  return pages;
}

// Slot order: left to right, top to bottom, the order a person reads a sheet in.
function inSlotOrder(placements) {
  return [...placements].sort((a, b) => a.y - b.y || a.x - b.x);
}

// Which placements do not point the way every card on that page should.
function facingProblems(placements, up) {
  return placements
    .filter((placement) => placement.up !== up)
    .map((placement) => `${placement.image} at x=${placement.x.toFixed(1)} faces ${placement.up}`);
}

/**
 * The assertion the whole probe exists for.
 *
 * A printer flips the paper, and that flip is what mirrors the page. So a back
 * belongs at the horizontal reflection of its front: the two boxes have to add
 * up to the width of the sheet.
 *
 * Position alone is not enough to check, and that is worth spelling out because
 * the obvious test is wrong. On a three-column grid the set of x positions is
 * symmetric -- the outer columns swap and the middle one maps to itself -- so a
 * backing page drawn in the same order as the fronts occupies exactly the right
 * set of boxes and is still wrong on six cards out of nine. What has to hold is
 * the pairing: every card showing a given front must find the same back at its
 * mirror, and two decks' cards must find different ones.
 */
function pairFrontsToBacks(fronts, backs, pageWidth) {
  const atPosition = new Map(
    backs.map((back) => [`${back.x.toFixed(1)}:${back.y.toFixed(1)}`, back])
  );
  const pairs = new Map();
  const problems = [];

  for (const front of fronts) {
    const mirrored = pageWidth - front.x - front.width;
    const back = atPosition.get(`${mirrored.toFixed(1)}:${front.y.toFixed(1)}`);
    if (!back) {
      problems.push(`no back at x=${mirrored.toFixed(1)} y=${front.y.toFixed(1)}`);
      continue;
    }

    const already = pairs.get(front.image);
    if (already !== undefined && already !== back.image) {
      problems.push(`${front.image} is backed by both ${already} and ${back.image}`);
    }
    pairs.set(front.image, back.image);
  }

  return { pairs, problems };
}

async function run() {
  const api = await inspectApi(API);
  const refusal = probeRefusal('check:print', api);
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
    console.warn('[check:print] no browser engine available; skipping');
    return 0;
  }

  const pageErrors = [];
  browser.page.on('pageerror', (error) => pageErrors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  try {
    await signUp(browser, base, { name: 'Print Probe', stamp: Date.now() });
    await createProject(browser, 'Print Project');

    // Fronts, backs and the two decks are set up through the API rather than the
    // editor: this probe is about the file that comes out, and check-upload
    // already drives the real picker. The card art is a different flat colour
    // each, which is what makes the placements tellable apart in the PDF.
    const artwork = {
      alpha: [200, 40, 40],
      beta: [40, 160, 90],
      gamma: [60, 90, 200],
      // In a deck and printed none of. Every count below is measured with it
      // there, so a regression that expanded it would move all three of them.
      delta: [120, 60, 170],
      'back-one': [30, 30, 30],
      'back-two': [230, 210, 120],
    };
    // Minis at their own aspect, so a turned card's box is exactly its cell and
    // the reader measures the turn rather than a clipped overflow.
    const minis = {
      'mini-one': [200, 120, 40],
      'mini-two': [40, 120, 200],
      'back-mini': [90, 40, 20],
    };
    // Beta's artwork after somebody has redrawn it. Not in the map above,
    // because it is uploaded as a second version of a card rather than as a
    // card of its own -- which is what the reprint half of this probe is about.
    const redrawn = [...solidPng({ width: 372, height: 520, rgb: [240, 200, 40] })];

    const files = Object.fromEntries([
      ...Object.entries(artwork).map(([name, rgb]) => [
        name,
        [...solidPng({ width: 372, height: 520, rgb })],
      ]),
      ...Object.entries(minis).map(([name, rgb]) => [
        name,
        [...solidPng({ width: 264, height: 402, rgb })],
      ]),
    ]);

    const setup = await browser.page.evaluate(async (uploads) => {
      const token = localStorage.getItem('tph.token');
      const headers = { Authorization: `Bearer ${token}` };
      const projectId = (await fetch('/api/projects', { headers }).then((r) => r.json()))
        .projects[0].id;

      // Into the deck, not into the project: a deck owns its cards and its back,
      // so each one is created first and its artwork uploaded into it.
      const makeDeck = async (name, back, cards, [width, height] = [63, 88]) => {
        const deck = await fetch('/api/decks', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            name,
            card_width_mm: width,
            card_height_mm: height,
          }),
        }).then((r) => r.json());

        const into = async (image, role) => {
          const query = new URLSearchParams({
            project_id: projectId,
            filename: `${image}.png`,
            deck_id: deck.id,
            ...(role ? { role } : {}),
          });
          const created = await fetch(`/api/files/upload?${query}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'image/png' },
            body: new Uint8Array(uploads[image]),
          }).then((r) => r.json());
          return created.id;
        };

        const placed = [];
        for (const card of cards) placed.push({ ...card, file_id: await into(card.image) });

        await fetch(`/api/decks/${deck.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ back_file_id: await into(back, 'back') }),
        });

        const saved = await fetch(`/api/decks/${deck.id}/cards`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cards: placed.map((card) => ({ file_id: card.file_id, quantity: card.quantity })),
          }),
        }).then((r) => r.json());
        return saved.deck;
      };

      // Eight pieces of card in the first deck and three in the second: the
      // first sheet then carries both decks, which is the case a per-sheet back
      // would get wrong and a per-slot back gets right. Alpha's third card is
      // held at no copies, so the deck lists three and prints eight.
      const alpha = await makeDeck('Alpha deck', 'back-one', [
        { image: 'alpha', quantity: 6 },
        { image: 'beta', quantity: 2 },
        { image: 'delta', quantity: 0 },
      ]);
      const beta = await makeDeck('Beta deck', 'back-two', [{ image: 'gamma', quantity: 3 }]);

      // A full sheet of minis. The planner turns these on their side to fit
      // eighteen, and the sheet is sorted after the poker run by deck name.
      await makeDeck(
        'Mini deck',
        'back-mini',
        [
          { image: 'mini-one', quantity: 10 },
          { image: 'mini-two', quantity: 8 },
        ],
        [44, 67]
      );

      return { projectId, alpha, beta };
    }, files);

    // Read back rather than assumed. A quantity of zero the API had refused
    // would leave a two-card deck, and every count below would still come out
    // exactly right -- which is this probe's own version of measuring nothing.
    check(
      'a deck holds a card it prints none of',
      setup.alpha.card_count === 3 && setup.alpha.total_copies === 8,
      `${setup.alpha.card_count} cards, ${setup.alpha.total_copies} copies`
    );

    await browser.goto(`${base}/projects/${setup.projectId}/print`, { wait: 0 });
    await browser.page.waitForSelector('h1:has-text("Print sheets")', { timeout: 15_000 });
    check('the print screen opens', true);

    // The button only renders once every deck has been read, so waiting for it
    // is what tells the loading spinner apart from the summary -- both carry
    // role="status", and reading too early found "Loading decks".
    await browser.page.waitForSelector('button:has-text("Generate PDF")', { timeout: 30_000 });

    // 11 poker cards at 9 a sheet is two sheets and 18 minis is one, with a
    // backing page behind each.
    const said = await browser.page.textContent('p:has-text("sheets of US Letter")');
    check(
      'the screen counts the cards and the sheets before printing',
      /29\s+cards on 6\s+sheets/.test(said ?? '') && /across 2 card sizes/.test(said ?? ''),
      said ?? ''
    );

    // The bytes are captured from the object URL the button builds rather than
    // through a download: the app hands the visitor a Blob it made in the page,
    // and reading it here is both simpler and exactly what they receive.
    await browser.page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      window.__printed = null;
      URL.createObjectURL = (blob) => {
        window.__printed = blob;
        return original(blob);
      };
    });

    await browser.click('button:has-text("Generate PDF")');
    await browser.page.waitForFunction(() => window.__printed !== null, { timeout: 120_000 });

    const produced = await browser.page.evaluate(async () => {
      const blob = window.__printed;
      return { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
    });

    const bytes = Uint8Array.from(produced.bytes);
    const latin = Buffer.from(bytes).toString('latin1');

    check('the file is a PDF', latin.startsWith('%PDF-'), latin.slice(0, 8));
    check('it is handed over as a PDF blob', produced.type === 'application/pdf', produced.type);

    const mediaBoxes = [...latin.matchAll(/\/MediaBox \[([^\]]*)\]/g)].map((box) =>
      box[1].trim().split(/\s+/).map(Number)
    );
    check(
      'every page is US Letter',
      mediaBoxes.length > 0 &&
        mediaBoxes.every(
          (box) => Math.abs(box[2] - LETTER_WIDTH_PT) < 1 && Math.abs(box[3] - LETTER_HEIGHT_PT) < 1
        ),
      JSON.stringify(mediaBoxes[0])
    );

    const pageCount = (latin.match(/\/Type \/Page[^s]/g) ?? []).length;
    check('fronts and backs come to six pages', pageCount === 6, String(pageCount));

    // Five poker fronts and backs out of six uploaded, and three minis. Without
    // the alias every one of the 29 cards and 29 backs would be embedded
    // separately; with the zeroed card printed it would be nine.
    const embedded = (latin.match(/\/Subtype \/Image/g) ?? []).length;
    check('each distinct artwork is embedded once', embedded === 8, `${embedded} image XObjects`);

    const pages = readPlacements(bytes);
    if (
      !check('the page contents could be read back', pages.length >= 6, `${pages.length} pages`)
    ) {
      return 1;
    }

    const [frontOne, backOne, frontTwo, backTwo, frontMini, backMini] = pages.map(inSlotOrder);

    check('the first sheet is full', frontOne.length === POKER_PER_SHEET, String(frontOne.length));
    check(
      'the second sheet holds the remaining two',
      frontTwo.length === 2,
      String(frontTwo.length)
    );

    // Alpha deck lists four cards and one of them is held at no copies. Printed,
    // it would take the eleventh slot and put a fourth artwork on the fronts.
    const drawn = new Set([...frontOne, ...frontTwo].map((placement) => placement.image));
    check(
      'the card the deck prints none of takes no slot',
      drawn.size === 3,
      `${drawn.size} artworks over ${frontOne.length + frontTwo.length} slots`
    );

    const cardWidthMm = frontOne[0].width * MM_PER_PT;
    const cardHeightMm = frontOne[0].height * MM_PER_PT;
    check(
      'a card measures 63 x 88 mm on the page',
      Math.abs(cardWidthMm - 63) < 0.2 && Math.abs(cardHeightMm - 88) < 0.2,
      `${cardWidthMm.toFixed(2)} x ${cardHeightMm.toFixed(2)} mm`
    );

    // Cards butt against each other, so a column boundary is one cut.
    const adjacent = Math.abs(frontOne[1].x - (frontOne[0].x + frontOne[0].width)) < 0.5;
    check('neighbouring cards share a cut line', adjacent);

    check(
      'an upright card and its back both point up the page',
      facingProblems([...frontOne, ...backOne, ...frontTwo, ...backTwo], 'N').length === 0,
      facingProblems([...frontOne, ...backOne, ...frontTwo, ...backTwo], 'N').join('; ')
    );

    const firstSheet = pairFrontsToBacks(frontOne, backOne, LETTER_WIDTH_PT);
    const secondSheet = pairFrontsToBacks(frontTwo, backTwo, LETTER_WIDTH_PT);

    for (const [label, sheet] of [
      ['first', firstSheet],
      ['second', secondSheet],
    ]) {
      check(
        `every card on the ${label} sheet finds its own back at its mirror`,
        sheet.problems.length === 0,
        sheet.problems.join('; ')
      );
    }

    // The deck boundary. Alpha's eight cards take slots 0-7 of the first sheet
    // and Beta's first card takes slot 8, so that one sheet has to carry both
    // decks' backs -- which is the case a per-sheet back gets wrong.
    check(
      'the sheet drawn from two decks uses both of their backs',
      new Set(firstSheet.pairs.values()).size === 2,
      `fronts ${JSON.stringify([...firstSheet.pairs])}`
    );
    check(
      'the two artworks from one deck share that deck’s back',
      firstSheet.pairs.size === 3 && new Set(firstSheet.pairs.values()).size === 2,
      `${firstSheet.pairs.size} distinct fronts on the sheet`
    );

    // The turned sheet. The bug this half exists for drew every mini upright at
    // the width of its landscape cell and clipped it to a band of its middle:
    // eighteen boxes in the right places, every one of them the wrong picture.
    check('the mini sheet is full', frontMini.length === MINI_PER_SHEET, String(frontMini.length));

    const miniWidthMm = frontMini[0].width * MM_PER_PT;
    const miniHeightMm = frontMini[0].height * MM_PER_PT;
    check(
      'a mini lies on its side, 67 x 44 mm on the page',
      Math.abs(miniWidthMm - 67) < 0.2 && Math.abs(miniHeightMm - 44) < 0.2,
      `${miniWidthMm.toFixed(2)} x ${miniHeightMm.toFixed(2)} mm`
    );
    check(
      'every mini’s artwork is turned to lie the same way',
      facingProblems(frontMini, 'E').length === 0,
      facingProblems(frontMini, 'E').join('; ')
    );
    check(
      'neighbouring minis share a cut line',
      Math.abs(frontMini[1].x - (frontMini[0].x + frontMini[0].width)) < 0.5
    );

    // A long-edge flip reverses left and right, which is the axis a sideways
    // card's top lies along -- so behind a mini turned one way sits its back
    // turned the other, at the mirror of its slot.
    const miniSheet = pairFrontsToBacks(frontMini, backMini, LETTER_WIDTH_PT);
    check(
      'every mini finds its own back at its mirror',
      miniSheet.problems.length === 0 && miniSheet.pairs.size === 2,
      miniSheet.problems.join('; ') || `${miniSheet.pairs.size} distinct fronts`
    );
    check(
      'a mini’s back is turned the opposite way to its front',
      facingProblems(backMini, 'W').length === 0,
      facingProblems(backMini, 'W').join('; ')
    );

    // --- printing only what has changed ---------------------------------
    //
    // Generating the document is what records it, so by here the printer is
    // square with all 29 cards. Give one of them new artwork and ask again in
    // the changed mode: what has to come out is that card and nothing else.
    // Nothing short of a real file can say so -- the counts on the screen are
    // computed from the same numbers the plan is, so they would agree with a
    // planner that had quietly kept every card.
    await browser.page.waitForSelector('p:has-text("Recorded as printed")', { timeout: 30_000 });
    check('the run it built is written down as printed', true);

    const redrew = await browser.page.evaluate(
      async (payload) => {
        const token = localStorage.getItem('tph.token');
        const headers = { Authorization: `Bearer ${token}` };
        const deck = await fetch(`/api/decks/${payload.deckId}`, { headers }).then((r) => r.json());
        const card = deck.cards.find((row) => row.file.filename === 'beta.png');
        const res = await fetch(`/api/files/${card.file_id}/versions`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'image/png' },
          body: new Uint8Array(payload.bytes),
        });
        const body = await res.json();
        return { status: res.status, number: body.version?.version_number ?? null };
      },
      { deckId: setup.alpha.id, bytes: redrawn }
    );

    check(
      'one card is given new artwork',
      redrew.status === 201 && redrew.number === 2,
      `${redrew.status}, version ${redrew.number}`
    );

    await browser.goto(`${base}/projects/${setup.projectId}/print`, { wait: 0 });
    await browser.page.waitForSelector('button:has-text("Generate PDF")', { timeout: 30_000 });
    await browser.page.getByLabel('What to print').selectOption('changed');

    const reprintSaid = await browser.page.textContent('p:has-text("sheets of US Letter")');
    check(
      'the screen counts only the two copies of the card that changed',
      /\b2\s+cards on 2\s+sheets/.test(reprintSaid ?? ''),
      reprintSaid ?? ''
    );

    await browser.page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      window.__printed = null;
      URL.createObjectURL = (blob) => {
        window.__printed = blob;
        return original(blob);
      };
    });
    await browser.click('button:has-text("Generate PDF")');
    await browser.page.waitForFunction(() => window.__printed !== null, { timeout: 120_000 });

    const reprintBytes = Uint8Array.from(
      await browser.page.evaluate(async () => [
        ...new Uint8Array(await window.__printed.arrayBuffer()),
      ])
    );
    const reprintLatin = Buffer.from(reprintBytes).toString('latin1');

    check(
      'the reprint is one front sheet and its backing page',
      (reprintLatin.match(/\/Type \/Page[^s]/g) ?? []).length === 2,
      String((reprintLatin.match(/\/Type \/Page[^s]/g) ?? []).length)
    );

    const reprintPages = readPlacements(reprintBytes).map(inSlotOrder);
    check(
      'the reprint holds two cards and nothing else',
      reprintPages[0]?.length === 2,
      `${reprintPages[0]?.length} slots`
    );
    check(
      'both of them are the one card that changed',
      new Set(reprintPages[0].map((placement) => placement.image)).size === 1,
      `${new Set(reprintPages[0].map((placement) => placement.image)).size} artworks`
    );
    check(
      'the redrawn card and its back are the only artwork embedded',
      (reprintLatin.match(/\/Subtype \/Image/g) ?? []).length === 2,
      `${(reprintLatin.match(/\/Subtype \/Image/g) ?? []).length} image XObjects`
    );
    check(
      'the reprint still puts a back behind its card',
      pairFrontsToBacks(reprintPages[0], reprintPages[1], LETTER_WIDTH_PT).problems.length === 0,
      pairFrontsToBacks(reprintPages[0], reprintPages[1], LETTER_WIDTH_PT).problems.join('; ')
    );

    // And once that is recorded too, the deck owes nothing again -- which is the
    // half a run that recorded the wrong version would fail.
    await browser.page.waitForSelector('p:has-text("Recorded as printed")', { timeout: 30_000 });
    const settled = await browser.page.evaluate(async (projectId) => {
      const token = localStorage.getItem('tph.token');
      const body = await fetch(`/api/print/outstanding?project_id=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      return body.decks.flatMap((deck) => deck.cards).filter((card) => card.owed_copies > 0);
    }, setup.projectId);
    check(
      'nothing is left owing once the reprint is recorded',
      settled.length === 0,
      JSON.stringify(settled)
    );

    // --- a count typed over the deck's own --------------------------------
    //
    // The copy count is the number a field starts at and nothing more, and only
    // a real file can say that what is in the field is what reaches the paper:
    // the count beside a card and the summary above the button are computed
    // from the same expression the plan is, so a screen reading five over a
    // planner that had quietly kept three would agree with itself.
    await browser.goto(`${base}/projects/${setup.projectId}/print?deck=${setup.beta.id}`, {
      wait: 0,
    });
    await browser.page.waitForSelector('button:has-text("Generate PDF")', { timeout: 30_000 });
    await browser.page
      .locator('li', { hasText: 'Beta deck' })
      .getByRole('button', { name: 'Choose cards' })
      .click();

    const count = browser.page.getByLabel('Copies of gamma.png');
    const started = await count.inputValue();
    check('a card’s field starts at the count its deck holds', started === '3', started);

    // Clicked and typed rather than filled: the field selects what is in it on
    // focus, and the change the screen reads is the one a person's keystrokes
    // and Tab produce.
    await count.click();
    await browser.page.keyboard.type('5');
    await browser.page.keyboard.press('Tab');
    const typed = await count.inputValue();
    check('the field takes the number that was typed', typed === '5', typed);

    const typedSaid = await browser.page.textContent('p:has-text("sheets of US Letter")');
    check(
      'the sheets are counted from the typed number, not the deck’s',
      /\b5\s+cards on 2\s+sheets/.test(typedSaid ?? ''),
      typedSaid ?? ''
    );

    await browser.page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      window.__printed = null;
      URL.createObjectURL = (blob) => {
        window.__printed = blob;
        return original(blob);
      };
    });
    await browser.click('button:has-text("Generate PDF")');
    await browser.page.waitForFunction(() => window.__printed !== null, { timeout: 120_000 });

    const typedBytes = Uint8Array.from(
      await browser.page.evaluate(async () => [
        ...new Uint8Array(await window.__printed.arrayBuffer()),
      ])
    );
    const typedPages = readPlacements(typedBytes).map(inSlotOrder);
    check(
      'the sheet holds the five copies that were asked for',
      typedPages[0]?.length === 5,
      `${typedPages[0]?.length} slots`
    );
    check(
      'all five are the one card',
      new Set((typedPages[0] ?? []).map((placement) => placement.image)).size === 1,
      `${new Set((typedPages[0] ?? []).map((placement) => placement.image)).size} artworks`
    );

    await browser.page.waitForSelector('p:has-text("Recorded as printed")', { timeout: 30_000 });
    const ledger = await browser.page.textContent('p:has-text("Recorded as printed")');
    check(
      'the ledger is written at the typed count',
      /5\s+copies of 1\s+card/.test(ledger ?? ''),
      ledger ?? ''
    );
    // --- choosing what goes on paper -------------------------------------
    //
    // The boxes above the Generate button were covered by nothing that ran a
    // browser: every pass above printed whatever the screen selected for itself.
    // Two things have to hold -- a deck's box reports what its own cards say,
    // and the file holds exactly what is left ticked. The second is a fact about
    // the finished document, and the counts on the screen cannot settle it: they
    // are computed from the same selection the plan is, so they would agree with
    // a renderer that had quietly kept every card.
    await browser.goto(`${base}/projects/${setup.projectId}/print`, { wait: 0 });
    await browser.page.waitForSelector('button:has-text("Generate PDF")', { timeout: 30_000 });

    const deckRow = (name) => browser.page.getByRole('listitem').filter({ hasText: name });
    const deckBox = (name) => browser.page.getByRole('checkbox', { name });
    const cardBox = (deck, filename) => deckRow(deck).getByRole('checkbox', { name: filename });
    const boxState = (box) =>
      box.evaluate((input) => ({ checked: input.checked, mixed: input.indeterminate }));

    // Svelte settles in a microtask that a click does not wait for, so the count
    // is waited for rather than read -- and a wait that times out still reports
    // whatever the screen actually says, which is the number worth seeing.
    const counts = async (pattern) => {
      const found = await browser.page
        .waitForFunction(
          (source) => new RegExp(source).test(document.body.textContent ?? ''),
          pattern.source,
          { timeout: 10_000 }
        )
        .then(() => true)
        .catch(() => false);
      const said = await browser.page.textContent('p:has-text("sheets of US Letter")');
      return { found, said: said ?? '' };
    };

    const opening = await Promise.all(
      ['Alpha deck', 'Beta deck', 'Mini deck'].map((name) => boxState(deckBox(name)))
    );
    const whole = await counts(/29\s+cards on 6\s+sheets/);
    check(
      'every deck starts fully ticked, none of them mixed',
      opening.every((box) => box.checked && !box.mixed) && whole.found,
      `${JSON.stringify(opening)} ${whole.said}`
    );

    await deckRow('Alpha deck').getByRole('button', { name: 'Choose cards' }).click();
    await cardBox('Alpha deck', 'alpha.png').click();
    await browser.page.waitForSelector('text=2 of 3 cards', { timeout: 10_000 });

    const mixed = await boxState(deckBox('Alpha deck'));
    check(
      'unticking one card reports its deck as mixed',
      !mixed.checked && mixed.mixed,
      JSON.stringify(mixed)
    );

    // Alpha prints six of that card, so the run loses six of its twenty-nine and
    // the eleven-card poker run comes down to one sheet.
    const short = await counts(/23\s+cards on 4\s+sheets/);
    check('the run loses exactly that card’s copies', short.found, short.said);

    await deckBox('Alpha deck').click();
    const filled = await boxState(deckBox('Alpha deck'));
    const refilled = await counts(/29\s+cards on 6\s+sheets/);
    check(
      'a mixed box ticks the rest of the deck rather than clearing it',
      filled.checked && !filled.mixed && refilled.found,
      `${JSON.stringify(filled)} ${refilled.said}`
    );

    await deckBox('Alpha deck').click();
    const cleared = await Promise.all(
      ['alpha.png', 'beta.png', 'delta.png'].map((name) =>
        cardBox('Alpha deck', name).evaluate((input) => input.checked)
      )
    );
    const emptied = await boxState(deckBox('Alpha deck'));
    const without = await counts(/21\s+cards on 4\s+sheets/);
    check(
      'a ticked box clears every card under it',
      cleared.every((ticked) => !ticked) && !emptied.checked && !emptied.mixed && without.found,
      `${JSON.stringify(cleared)} ${without.said}`
    );

    // Back to a part-ticked deck with a second deck cleared outright, which is a
    // sheet no default selection could have produced: two copies of one deck's
    // card beside three of another's, and nothing else on the paper.
    await deckBox('Alpha deck').click();
    await cardBox('Alpha deck', 'alpha.png').click();
    await deckBox('Mini deck').click();
    const chosen = await counts(/5\s+cards on 2\s+sheets/);
    check('the screen counts the part-ticked selection', chosen.found, chosen.said);

    await browser.page.evaluate(() => {
      const original = URL.createObjectURL.bind(URL);
      window.__printed = null;
      URL.createObjectURL = (blob) => {
        window.__printed = blob;
        return original(blob);
      };
    });
    await browser.click('button:has-text("Generate PDF")');
    await browser.page.waitForFunction(() => window.__printed !== null, { timeout: 120_000 });

    const chosenBytes = Uint8Array.from(
      await browser.page.evaluate(async () => [
        ...new Uint8Array(await window.__printed.arrayBuffer()),
      ])
    );
    const chosenLatin = Buffer.from(chosenBytes).toString('latin1');
    const chosenPages = readPlacements(chosenBytes).map(inSlotOrder);
    const chosenImages = (chosenLatin.match(/\/Subtype \/Image/g) ?? []).length;

    check(
      'the chosen cards come to one sheet and its back',
      (chosenLatin.match(/\/Type \/Page[^s]/g) ?? []).length === 2,
      String((chosenLatin.match(/\/Type \/Page[^s]/g) ?? []).length)
    );
    // Not an early return: every assertion below says something different about
    // the same sheet, and a run that stopped here would name one symptom of a
    // selection that never reached the file instead of all four.
    const chosenFront = chosenPages[0] ?? [];
    check(
      'the sheet holds only what was left ticked',
      chosenFront.length === 5,
      `${chosenFront.length} slots`
    );

    const chosenArtwork = new Set(chosenFront.map((placement) => placement.image));
    check(
      'the unticked card takes none of those slots',
      chosenArtwork.size === 2,
      `${chosenArtwork.size} artworks over ${chosenFront.length} slots`
    );
    // The mini deck was cleared from its own box, so nothing on the page may
    // measure 67 x 44: a turned card there would say the box moved the screen
    // and not the run.
    const upright = chosenFront.map((placement) => ({
      width: placement.width * MM_PER_PT,
      height: placement.height * MM_PER_PT,
    }));
    check(
      'the deck cleared from its own box put nothing on the page',
      upright.every((size) => Math.abs(size.width - 63) < 0.2 && Math.abs(size.height - 88) < 0.2),
      upright.map((size) => `${size.width.toFixed(1)}x${size.height.toFixed(1)}`).join(' ')
    );
    check(
      'nothing but those two cards and their backs is embedded',
      chosenImages === 4,
      `${chosenImages} image XObjects`
    );

    // A part-ticked run still resolves a back per slot: the cards left on the
    // sheet come from two decks and have to find two different backs.
    const chosenSheet = pairFrontsToBacks(chosenFront, chosenPages[1] ?? [], LETTER_WIDTH_PT);
    check(
      'each chosen card still finds its own deck’s back at its mirror',
      chosenSheet.problems.length === 0 && new Set(chosenSheet.pairs.values()).size === 2,
      chosenSheet.problems.join('; ') || `${new Set(chosenSheet.pairs.values()).size} backs`
    );

    if (pageErrors.length > 0) {
      check('the page threw nothing while building the sheets', false, pageErrors.join(' | '));
    }

    if (selftest) {
      // Sensitivity. The mirror assertion is the one that matters and the one
      // that would pass vacuously if it were reading the wrong numbers, so run
      // it against a backing page that was laid out without the mirror -- the
      // exact bug it is there to catch -- and require it to complain.
      console.log('\n[selftest] the same assertions against a backing page that was not mirrored:');

      // The exact bug: each card's back drawn at that card's own slot rather
      // than at its mirror. Every box on the page is still occupied and every
      // back still appears the right number of times -- which is why position
      // alone cannot see it, and why this arm exists.
      const mirrorSlot = (slot) =>
        Math.floor(slot / POKER_COLUMNS) * POKER_COLUMNS +
        (POKER_COLUMNS - 1 - (slot % POKER_COLUMNS));
      const correctBacks = inSlotOrder(backOne);
      const unmirrored = correctBacks.map((back, slot) => ({
        ...back,
        image: correctBacks[mirrorSlot(slot)].image,
      }));

      const notMirrored = pairFrontsToBacks(frontOne, unmirrored, LETTER_WIDTH_PT);
      if (notMirrored.problems.length === 0) {
        console.error('[selftest] FAILED: an unmirrored backing page was accepted');
        return 1;
      }
      console.log(
        `  ok   an unmirrored backing page is rejected (${notMirrored.problems.join('; ')})`
      );

      // And the second assertion the real run makes has to see it too: with the
      // mirror gone, one deck's cards no longer agree on a back, so the sheet
      // stops carrying two distinct ones.
      if (new Set(notMirrored.pairs.values()).size === 2) {
        console.error('[selftest] FAILED: an unmirrored page still looked like two decks of backs');
        return 1;
      }
      console.log('  ok   an unmirrored page no longer reads as two decks of backs');

      const shifted = backOne.map((back) => ({ ...back, x: back.x + 2 }));
      if (pairFrontsToBacks(frontOne, shifted, LETTER_WIDTH_PT).problems.length === 0) {
        console.error('[selftest] FAILED: a backing page shifted by 2pt was accepted');
        return 1;
      }
      console.log('  ok   a backing page off by two points is rejected');

      // The turned sheet's own bug: a back drawn through the same turn as its
      // front, which lands in the right box and comes out upside down once the
      // card is cut. Every position on the page is still right.
      const sameWayUp = backMini.map((back) => ({ ...back, up: 'E' }));
      if (facingProblems(sameWayUp, 'W').length === 0) {
        console.error('[selftest] FAILED: backs turned the same way as their fronts were accepted');
        return 1;
      }
      console.log('  ok   a turned sheet whose backs face the same way as its fronts is rejected');

      // And the reader itself, against a stream written by hand in the three-
      // operator form jsPDF uses for a turned image: a 190 x 125 pt image turned
      // a quarter clockwise about (100, 500) covers a 125 x 190 pt box to the
      // right of and below that point, with its top pointing east. A reader
      // that took the last matrix alone would put it at the origin.
      const turnedStream = readStream(
        'q 1 0 0 1 100 500 cm 0.0000 -1.0000 1.0000 0.0000 0 0 cm 190 0 0 125 0 0 cm /I7 Do Q'
      );
      const [turned] = turnedStream;
      const readsTurned =
        turnedStream.length === 1 &&
        turned.image === 'I7' &&
        Math.abs(turned.x - 100) < 1e-6 &&
        Math.abs(turned.y - (LETTER_HEIGHT_PT - 500)) < 1e-6 &&
        Math.abs(turned.width - 125) < 1e-6 &&
        Math.abs(turned.height - 190) < 1e-6 &&
        turned.up === 'E';
      if (!readsTurned) {
        console.error(
          `[selftest] FAILED: a turned placement read back as ${JSON.stringify(turned)}`
        );
        return 1;
      }
      console.log('  ok   a turned placement is read back at its box, facing east');

      // The same stream under the two-operator upright form, so the walker is
      // known to agree with the pattern the reader used to match.
      const deflated = Buffer.concat([
        Buffer.from('stream\n', 'latin1'),
        deflateSync(Buffer.from('q 190 0 0 125 100 500 cm /I3 Do Q', 'latin1')),
        Buffer.from('endstream', 'latin1'),
      ]);
      const [[upright]] = readPlacements(deflated);
      if (
        !upright ||
        upright.width !== 190 ||
        upright.height !== 125 ||
        upright.x !== 100 ||
        upright.y !== LETTER_HEIGHT_PT - 625 ||
        upright.up !== 'N'
      ) {
        console.error(
          `[selftest] FAILED: an upright placement read back as ${JSON.stringify(upright)}`
        );
        return 1;
      }
      console.log('  ok   an upright placement is read back at its box, facing north');

      // The arms above prove the reader reads a document correctly. This one
      // proves the boxes reach the document at all, which no amount of reading
      // can say -- so it re-runs the whole probe against a screen carrying the
      // one bug the counts cannot show: the plan honours the selection and the
      // renderer is handed every card regardless. Every assertion above the
      // Generate button still passes there, and only the placements catch it.
      if (!process.env[MUTATED]) {
        console.log('\n[selftest] the selection section against a renderer that ignores it:');
        const ignored = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
          env: {
            ...process.env,
            [MUTATED]: '1',
            GUARD_CACHE_DIR: join(mkdtempSync(join(tmpdir(), 'print-probe-')), 'vite'),
            GUARD_MUTATION: JSON.stringify({
              file: 'src/routes/Print.svelte',
              find: '{ decks: runDecks, options, versions: $state.snapshot(versions) }',
              replace:
                '{ decks: loaded.map((entry) => ({ name: entry.deck.name, card: deckCardSize(entry.deck), back_file_id: entry.deck.back_file_id, cards: entry.cards.filter((card) => card.quantity > 0).map((card) => ({ file_id: card.file_id, copies: card.quantity })) })), options, versions: $state.snapshot(versions) }',
            }),
          },
          encoding: 'utf8',
          timeout: 600_000,
        });

        const output = `${ignored.stdout ?? ''}${ignored.stderr ?? ''}`;
        // Two assertions the full sheet cannot satisfy: it carries nine slots
        // rather than five, and a third deck's artwork beyond the two decks
        // that were left ticked. The card-size check is deliberately not one of
        // them -- a full poker sheet is 63 x 88 throughout and passes it, which
        // is exactly why it is not the assertion this rests on.
        const caught = [
          'the sheet holds only what was left ticked',
          'nothing but those two cards and their backs is embedded',
        ].filter((name) => output.includes(`FAIL ${name}`));

        // The mutation has to have been applied, the counts on the screen have
        // to have gone on passing, and the file has to have been the thing that
        // complained. A run that failed for some other reason proves nothing.
        if (!output.includes('ok   the screen counts the part-ticked selection')) {
          console.error('[selftest] FAILED: the mutated run did not reach the selection section');
          console.error(output.split('\n').slice(-25).join('\n'));
          return 1;
        }
        if (ignored.status === 0 || caught.length !== 2) {
          console.error(
            `[selftest] FAILED: a document that ignored the selection was accepted (exit ${ignored.status}, caught ${caught.length} of 2)`
          );
          console.error(output.split('\n').slice(-25).join('\n'));
          return 1;
        }
        console.log(
          `  ok   a document that ignored the selection is rejected (${caught.join('; ')})`
        );
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\ncheck:print passed');
  return 0;
}

process.exit(await run());
