// Drags a card and a component into a new place in a real browser, against a
// real API.
//
// jsdom can be handed the events svelte-dnd-action dispatches, and the unit
// tests do exactly that -- but it has no pointer, no layout and no animation, so
// everything between a press on the grip and those events is covered by nothing
// else: that the handle is what arms a drag, that the row follows the pointer
// far enough to change places, and that the drop writes the order once rather
// than once per frame. The grid is here as well as the list because a section
// wraps its rows, and which row a pointer is over in two dimensions is a
// question a column of them never asks.
//
// It needs an API. Point API_PROXY_TARGET at one (default localhost:17310) and
// it will sign up its own throwaway account.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBrowser } from './lib/browser.mjs';
import { solidPng } from './lib/fixtures.mjs';
import { createProject, inspectApi, signUp } from './lib/session.mjs';

const PORT = Number(process.env.REORDER_PROBE_PORT ?? 17331);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';
const selftest = process.argv.includes('--selftest');

const CARDS = ['card-1.png', 'card-2.png', 'card-3.png'];
const PIECES = ['Piece one', 'Piece two', 'Piece three'];

const DECK_ZONE = 'ul[aria-label="Cards, in the order they print"]';
const SECTION_ZONE = 'ul[aria-label="Wooden pieces, in order"]';

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

/**
 * One press, a walk to the middle of another row, a pause, and a release.
 *
 * Dispatched rather than driven through Playwright's own mouse because the
 * press has to land on a named element whose position this reads first; the
 * events are the ones a real gesture produces either way -- down on the target,
 * move and up on the document, which is where the library listens.
 *
 * `offHandle` presses on the row itself instead of its grip, which is the arm
 * the selftest needs: nothing may move.
 */
function dragOnto(browser, { grip, row, onto, offHandle = false }) {
  return browser.page.evaluate(
    async ({ grip, row, onto, offHandle }) => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const mouse = (target, type, x, y) =>
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
          })
        );

      const held = document.querySelector(offHandle ? row : grip);
      const lifted = document.querySelector(row);
      const target = document.querySelector(onto);
      if (!held || !lifted || !target)
        return { error: `no ${target ? 'row' : 'target'} on screen` };

      const from = held.getBoundingClientRect();
      const source = lifted.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const startX = Math.round(from.left + from.width / 2);
      const startY = Math.round(from.top + from.height / 2);
      // Where the pointer has to end for the DRAGGED ROW'S OWN CENTRE to land
      // on the target's, which is what the library decides a place from -- so
      // the grab offset has to be carried along. A grip near the foot of a
      // component card is most of a row below that centre, and aiming the
      // pointer itself at the target left the row hanging above the grid
      // entirely: dropped outside of any zone, and back where it started.
      const endX = Math.round(to.left + to.width / 2 + (startX - (source.left + source.width / 2)));
      const endY = Math.round(to.top + to.height / 2 + (startY - (source.top + source.height / 2)));

      mouse(held, 'mousedown', startX, startY);
      const steps = 12;
      for (let step = 1; step <= steps; step += 1) {
        mouse(
          document,
          'mousemove',
          Math.round(startX + ((endX - startX) * step) / steps),
          Math.round(startY + ((endY - startY) * step) / steps)
        );
        await pause(24);
      }
      // Read before the release, because the floating row is taken away by the
      // drop. Without it every assertion below is vacuous: a press that never
      // became a drag leaves the list exactly as a bounced drop does.
      const armed = document.getElementById('dnd-action-dragged-el') !== null;
      // The place a drop commits to is re-decided on a poll rather than per
      // move, so this holds still for longer than one interval -- which is what
      // a hand pausing before it lifts does anyway.
      await pause(400);
      mouse(document, 'mouseup', endX, endY);
      await pause(700);
      return { armed };
    },
    { grip, row, onto, offHandle }
  );
}

function drawnIn(browser, zone) {
  return browser.page.evaluate((selector) => {
    const list = document.querySelector(selector);
    if (!list) return null;
    return [...list.querySelectorAll(':scope > li')].map((row) => row.getAttribute('aria-label'));
  }, zone);
}

async function run() {
  const api = await inspectApi(API, [
    ['put', '/api/decks/{deckId}/cards'],
    ['put', '/api/components/order'],
  ]);
  if (!api.ok) {
    const message = `[check:reorder] ${api.reason}`;
    if (!api.absent) {
      console.error(message);
      return 1;
    }
    // The contract every probe here keeps, written out in check-upload.mjs.
    if (process.env.CI) {
      console.error(`${message}; refusing to skip under CI`);
      return 1;
    }
    console.warn(`${message}; skipping. Start it with \`pnpm dev:api\`.`);
    return 0;
  }

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
    console.warn('[check:reorder] no browser engine available; skipping');
    return 0;
  }

  const writes = [];
  browser.page.on('request', (request) => {
    if (request.method() !== 'PUT') return;
    const path = new URL(request.url()).pathname;
    if (!path.includes('/cards') && !path.includes('/components/order')) return;
    writes.push({ path, body: JSON.parse(request.postData() ?? '{}') });
  });

  try {
    await signUp(browser, base, { name: 'Reorder Probe', stamp: Date.now() });
    await createProject(browser, 'Reorder Project');

    const artwork = CARDS.map((_name, index) => [
      ...solidPng({ width: 60, height: 84, rgb: [40 + index * 60, 90, 200 - index * 60] }),
    ]);

    // Seeded through the API rather than the screens: what this probe is about
    // starts once a deck and a section already hold three rows each, and
    // building them by hand would be three minutes of clicking per run.
    const seed = await browser.page.evaluate(
      async ({ cards, pieces, images }) => {
        const token = localStorage.getItem('tph.token');
        const headers = { Authorization: `Bearer ${token}` };
        const json = { ...headers, 'Content-Type': 'application/json' };
        const projectId = (await fetch('/api/projects', { headers }).then((r) => r.json()))
          .projects[0].id;

        const deck = await fetch('/api/decks', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            project_id: projectId,
            name: 'Ordered deck',
            card_width_mm: 63,
            card_height_mm: 88,
          }),
        }).then((r) => r.json());

        const placed = [];
        for (const [index, filename] of cards.entries()) {
          const query = new URLSearchParams({ project_id: projectId, filename, deck_id: deck.id });
          const file = await fetch(`/api/files/upload?${query}`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'image/png' },
            body: new Uint8Array(images[index]),
          }).then((r) => r.json());
          placed.push({ file_id: file.id, quantity: 1 });
        }
        await fetch(`/api/decks/${deck.id}/cards`, {
          method: 'PUT',
          headers: json,
          body: JSON.stringify({ cards: placed }),
        });

        for (const name of pieces) {
          await fetch('/api/components', {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ project_id: projectId, kind: 'wood', name }),
          });
        }

        return { projectId, deckId: deck.id };
      },
      { cards: CARDS, pieces: PIECES, images: artwork }
    );

    // --- a card, in a column ----------------------------------------------
    // The seeding above put the deck's cards there with a PUT of its own.
    writes.length = 0;
    await browser.goto(`${base}/projects/${seed.projectId}/decks/${seed.deckId}`, { wait: 600 });
    await browser.page.waitForSelector(`${DECK_ZONE} > li`, { timeout: 15_000 });

    const cardsBefore = await drawnIn(browser, DECK_ZONE);
    check(
      'the deck starts in the seeded order',
      String(cardsBefore) === String(CARDS),
      cardsBefore
    );

    const lifted = await dragOnto(browser, {
      grip: `[aria-label="Reorder ${CARDS[2]}"]`,
      row: `li[aria-label="${CARDS[2]}"]`,
      onto: `li[aria-label="${CARDS[0]}"]`,
    });
    check(
      'a press on the grip arms a drag',
      lifted.armed === true,
      lifted.error ?? 'nothing lifted'
    );

    const cardsAfter = await drawnIn(browser, DECK_ZONE);
    check(
      'the dragged card is drawn first',
      cardsAfter?.[0] === CARDS[2],
      `drawn as ${cardsAfter}`
    );

    const cardWrites = writes.filter((write) => write.path.endsWith('/cards'));
    check(
      'the drop writes the deck once',
      cardWrites.length === 1,
      `${cardWrites.length} requests`
    );

    // Reloaded rather than read off the screen: the list on screen is the one
    // the drop left behind, which says nothing about what was stored.
    await browser.goto(`${base}/projects/${seed.projectId}/decks/${seed.deckId}`, { wait: 600 });
    await browser.page.waitForSelector(`${DECK_ZONE} > li`, { timeout: 15_000 });
    const cardsReloaded = await drawnIn(browser, DECK_ZONE);
    check(
      'the new order is what the server hands back',
      String(cardsReloaded) === String(cardsAfter),
      `${cardsReloaded} vs ${cardsAfter}`
    );

    // --- a component, in a grid -------------------------------------------
    writes.length = 0;
    await browser.goto(`${base}/projects/${seed.projectId}/components/wood`, { wait: 600 });
    await browser.page.waitForSelector(`${SECTION_ZONE} > li`, { timeout: 15_000 });
    const piecesBefore = await drawnIn(browser, SECTION_ZONE);
    check(
      'a section lists its components in the order they were made',
      String(piecesBefore) === String(PIECES),
      piecesBefore
    );

    const grabbed = await dragOnto(browser, {
      grip: `[aria-label="Reorder ${PIECES[2]}"]`,
      row: `li[aria-label="${PIECES[2]}"]`,
      onto: `li[aria-label="${PIECES[0]}"]`,
    });
    check(
      'a press on a component’s grip arms a drag',
      grabbed.armed === true,
      grabbed.error ?? 'nothing lifted'
    );

    const piecesAfter = await drawnIn(browser, SECTION_ZONE);
    check(
      'the dragged component is drawn first',
      piecesAfter?.[0] === PIECES[2],
      `drawn as ${piecesAfter}`
    );

    const orderWrites = writes.filter((write) => write.path.endsWith('/components/order'));
    check(
      'the drop writes the section once',
      orderWrites.length === 1,
      `${orderWrites.length} requests`
    );
    check(
      'it sends the whole section, in the order on screen',
      orderWrites[0]?.body.component_ids.length === PIECES.length,
      JSON.stringify(orderWrites[0]?.body ?? null)
    );

    await browser.goto(`${base}/projects/${seed.projectId}/components/wood`, { wait: 600 });
    await browser.page.waitForSelector(`${SECTION_ZONE} > li`, { timeout: 15_000 });
    const piecesReloaded = await drawnIn(browser, SECTION_ZONE);
    check(
      'the section’s new order is what the server hands back',
      String(piecesReloaded) === String(piecesAfter),
      `${piecesReloaded} vs ${piecesAfter}`
    );

    if (selftest) {
      // Sensitivity: the same motion, started on the row instead of its grip.
      // A zone whose rows are all draggable would move this one, and so would a
      // probe whose "drag" is really the assertions agreeing with themselves --
      // both of which is what every check above would then be measuring.
      console.log('\n[selftest] the same motion started off the grip:');
      const before = await drawnIn(browser, SECTION_ZONE);
      const sent = writes.length;
      const bounced = await dragOnto(browser, {
        grip: `[aria-label="Reorder ${before[2]}"]`,
        row: `li[aria-label="${before[2]}"]`,
        onto: `li[aria-label="${before[0]}"]`,
        offHandle: true,
      });
      const after = await drawnIn(browser, SECTION_ZONE);

      if (bounced.armed || String(after) !== String(before) || writes.length !== sent) {
        console.error(
          `[selftest] FAILED: a press off the grip moved something (armed=${bounced.armed}, ` +
            `${before} -> ${after}, ${writes.length - sent} requests)`
        );
        return 1;
      }
      console.log('  ok   a press off the grip arms nothing, moves nothing and writes nothing');
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (browser.serverErrors.length > 0) {
    console.error(`\nthe API answered 5xx: ${browser.serverErrors.join(', ')}`);
    return 1;
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\ncheck:reorder passed');
  return 0;
}

process.exit(await run());
