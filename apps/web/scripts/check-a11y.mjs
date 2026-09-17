// Runs axe-core over the real screens, in BOTH colour schemes. The palette is
// declared twice and half the tokens exist only under
// prefers-color-scheme: dark, so a light-only run reads none of them.
//
// It owns a named rule list rather than running all of axe, so a new axe
// release cannot turn the gate red on a rule nobody has adopted.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBrowser } from './lib/browser.mjs';
import { TINY_PNG, solidPng } from './lib/fixtures.mjs';
import {
  createProject,
  inspectApi,
  openAssets,
  probeRefusal,
  signOut,
  signUp,
} from './lib/session.mjs';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const RULES = [
  'color-contrast',
  'label',
  'button-name',
  'link-name',
  'image-alt',
  'aria-valid-attr-value',
  'aria-required-attr',
  'aria-roles',
  'duplicate-id-aria',
  'form-field-multiple-labels',
  'html-has-lang',
  'landmark-one-main',
];

// `reach` says how to get to the screen. Signed-out screens are a URL; a screen
// behind the session needs an account, a project and something to open the
// screen on, so it names a function that leaves the browser sitting on it.
const SCREENS = [
  { name: 'login', path: '/login' },
  { name: 'signup', path: '/signup' },
  { name: 'forgot-password', path: '/forgot-password' },
  { name: 'component-studio', authed: true, reach: reachModelStudio },
  { name: 'component-section', authed: true, reach: reachComponentSection },
  { name: 'file-versions', authed: true, reach: reachFileVersions },
  { name: 'deleted', authed: true, reach: reachDeleted },
  { name: 'deck-editor', authed: true, reach: reachDeckEditor },
  { name: 'deck-card-viewer', authed: true, reach: reachCardViewer },
  { name: 'deck-history', authed: true, reach: reachDeckHistory },
  { name: 'deck-run', authed: true, reach: reachDeckRun },
  { name: 'deck-as-of', authed: true, reach: reachDeckAsOf },
  { name: 'print', authed: true, reach: reachPrint },
  { name: 'scene', authed: true, reach: reachScene },
];

const SCHEMES = ['light', 'dark'];

const selftest = process.argv.includes('--selftest');
const PORT = Number(process.env.A11Y_PROBE_PORT ?? 17330);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';

// A fresh account per screen and per colour scheme: the probes upload files, and
// an account carried from one screen to the next would make each run depend on
// what the one before it left behind.
async function freshProject(browser, base, label) {
  const dir = mkdtempSync(join(tmpdir(), 'tph-a11y-'));
  const pngPath = join(dir, 'token.png');
  writeFileSync(pngPath, TINY_PNG);

  await signOut(browser, base);
  await signUp(browser, base, { name: 'A11y Probe', stamp: `${Date.now()}-${label}` });
  await createProject(browser, `A11y ${label}`);
  await openAssets(browser);
  await browser.setInputFiles('input[type="file"]', pngPath);
  return 'token.png';
}

// A component, created through the real form and given its artwork: the studio
// is reached from the section a component lives in, not from a file in Assets.
async function reachModelStudio(browser, base, scheme) {
  const dir = mkdtempSync(join(tmpdir(), 'tph-a11y-'));
  const pngPath = join(dir, 'token.png');
  writeFileSync(pngPath, TINY_PNG);

  await signOut(browser, base);
  await signUp(browser, base, { name: 'A11y Probe', stamp: `${Date.now()}-studio-${scheme}` });
  await createProject(browser, `A11y studio-${scheme}`);

  await browser.page.waitForSelector('a:has-text("Wooden pieces")', { timeout: 15_000 });
  await browser.click('a:has-text("Wooden pieces")');
  await browser.page.waitForSelector('button:has-text("New wooden piece")', { timeout: 15_000 });
  await browser.click('button:has-text("New wooden piece")');
  await browser.page.fill('input[maxlength="120"]', `Meeple ${scheme}`);
  await browser.click('button[type="submit"]');

  await browser.page.waitForSelector(`h1:has-text("Meeple ${scheme}")`, { timeout: 15_000 });
  await browser.setInputFiles('input[type="file"]', pngPath);
  await expectCanvas(browser);
}

// A canvas that never appears is the studio having given up upstream -- an image
// it could not read, a project it could not resolve -- and it says which in a
// role="alert" that a bare selector timeout throws away.
async function expectCanvas(browser) {
  try {
    await browser.page.waitForSelector('canvas', { timeout: 15_000 });
  } catch (error) {
    const said = await browser.page
      .locator('[role="alert"]')
      .first()
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    if (said === null) throw error;
    throw new Error(`the model studio rendered no canvas; the screen says: ${said.trim()}`, {
      cause: error,
    });
  }
}

// A section with one component in it: a card each with a thumbnail, and the
// form that names a new one.
async function reachComponentSection(browser, base, scheme) {
  await reachModelStudio(browser, base, `section-${scheme}`);
  await browser.click('a:has-text("Back to wooden pieces")');
  await browser.page.waitForSelector('h1:has-text("Wooden pieces")', { timeout: 15_000 });
  await browser.click('button:has-text("New wooden piece")');
  await browser.page.waitForSelector('button[type="submit"]', { timeout: 15_000 });
}

async function reachFileVersions(browser, base, scheme) {
  const filename = await freshProject(browser, base, `versions-${scheme}`);
  await browser.page.waitForSelector(`button[aria-label="Download ${filename}"]`, {
    timeout: 15_000,
  });
  await browser.click('a:has-text("Versions")');
  // The upload control appears only once the member roster has answered, so
  // waiting for it is what keeps axe from reading a half-drawn screen.
  await browser.page.waitForSelector('button:has-text("Upload new version")', { timeout: 15_000 });
  await browser.page.waitForSelector(`button[aria-label="Download version 1 of ${filename}"]`, {
    timeout: 15_000,
  });
}

// Creates a deck through the real form and leaves the editor open with the file
// picker showing -- between them the deck screens carry more labelled controls
// than anything else in the app: two selects, four number inputs and a list
// whose reorder buttons are icons with nothing but an aria-label to read.
async function reachDeckEditor(browser, base, scheme) {
  await freshProject(browser, base, `deck-${scheme}`);
  await browser.click('a:has-text("Back to the project")');
  await browser.page.waitForSelector('a:has-text("Decks")', { timeout: 15_000 });
  await browser.click('a:has-text("Decks")');

  await browser.page.waitForSelector('button:has-text("New deck")', { timeout: 15_000 });
  await browser.click('button:has-text("New deck")');
  await browser.page.fill('input[maxlength="120"]', `Proof ${scheme}`);
  await browser.click('button[type="submit"]');

  // The editor is a different screen, not a panel: waiting for its own heading
  // is what keeps axe off the list it navigated away from.
  await browser.page.waitForSelector('h2:has-text("Cards")', { timeout: 15_000 });
  await browser.click('button:has-text("Move in from Assets")');
  await browser.page.waitForSelector('button:has-text("Add every image here")', {
    timeout: 15_000,
  });
}

// Two imports, driven against the API the way the Canva app drives it: the
// first makes a two-card deck, the second drops one of its pages and repeats
// the other byte for byte. What comes out is a run with something in every
// group the history screens can draw -- removed, unchanged, and a card still
// standing to photograph.
//
// Not through a screen, because there is none: importing happens inside Canva's
// editor, which no probe can open. What this covers is the history screens the
// runs leave behind, and those need a finished run rather than a way to make
// one.
const PAGES = [
  { page_id: 'a11y-page-1', bytes: solidPng({ width: 24, rgb: [220, 40, 40] }) },
  {
    page_id: 'a11y-page-2',
    title: 'Two of cups',
    bytes: solidPng({ width: 24, rgb: [40, 180, 90] }),
  },
];

async function importPages(token, deckId, pages) {
  const authed = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const post = async (path, init) => {
    const response = await fetch(`${API}${path}`, { method: 'POST', ...init });
    if (!response.ok) {
      throw new Error(`POST ${path} answered ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };

  const run = await post(`/api/decks/${deckId}/import/runs`, {
    headers: authed({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      source_label: 'Proof design',
      pages: pages.map((page, index) => ({
        page_number: index + 1,
        page_id: page.page_id,
        ...(page.title === undefined ? {} : { title: page.title }),
      })),
    }),
  });

  for (const [index, page] of pages.entries()) {
    const query = new URLSearchParams({ page_number: String(index + 1) });
    if (page.title !== undefined) query.set('title', page.title);
    await post(`/api/decks/import/runs/${run.id}/pages?${query}`, {
      headers: authed({ 'Content-Type': 'image/png' }),
      body: page.bytes,
    });
  }

  await post(`/api/decks/import/runs/${run.id}/finish`, { headers: authed() });
}

// The history screens have nothing to say about a deck nothing has imported
// into, and no other reach in this file produces a finished run.
async function reachImportedDeck(browser, base, scheme) {
  const deckName = `Proof history-${scheme}`;
  await reachDeckEditor(browser, base, `history-${scheme}`);

  // The session the browser is already holding, so the runs belong to the
  // signed-in account -- and the ids off the address bar, because the project
  // and the deck were both made through the forms rather than named here.
  const token = await browser.eval("localStorage.getItem('tph.token')");
  const [, , projectId, , deckId] = await browser.eval('location.pathname.split("/")');
  if (!token) throw new Error('the browser is holding no session token');

  await importPages(token, deckId, PAGES);
  await importPages(token, deckId, PAGES.slice(0, 1));

  // Back in through the deck list, so the screen is drawn from the rows the
  // imports left rather than from what it had already loaded.
  await browser.goto(`${base}/projects/${projectId}/decks`, { wait: 250 });
  await browser.click(`a:has-text("${deckName}")`);
  await browser.page.waitForSelector('h2:has-text("Cards")', { timeout: 15_000 });
}

// The viewer is drawn over a screen rather than as one of its own, and it is
// the only surface here with a scrim and a raised panel to answer for. It needs
// a deck with artwork in it, which the imports are what produce.
async function reachCardViewer(browser, base, scheme) {
  await reachImportedDeck(browser, base, `viewer-${scheme}`);
  await browser.page.locator('button:has-text("1.png")').first().click();
  await browser.page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
  // The artwork, not merely the frame around it: axe reading an empty panel
  // would leave the one thing this screen is drawn for unmeasured.
  await browser.page.waitForSelector('[role="dialog"] img', { timeout: 15_000 });
}

async function reachDeckHistory(browser, base, scheme) {
  await reachImportedDeck(browser, base, scheme);
  await browser.click('a:has-text("Import history")');
  // A run row, not the heading: axe reading the spinner would report an empty
  // screen as clean.
  await browser.page.waitForSelector('a:has-text("What changed")', { timeout: 15_000 });
  await browser.page.waitForSelector('a:has-text("The deck as it stood")', { timeout: 15_000 });
}

async function reachDeckRun(browser, base, scheme) {
  await reachDeckHistory(browser, base, `run-${scheme}`);
  // Newest first, so the first row is the import that dropped a page.
  await browser.page.locator('a:has-text("What changed")').first().click();
  await browser.page.waitForSelector('h2:has-text("Removed")', { timeout: 15_000 });
  await browser.page.waitForSelector('summary:has-text("unchanged")', { timeout: 15_000 });
}

async function reachDeckAsOf(browser, base, scheme) {
  await reachDeckHistory(browser, base, `asof-${scheme}`);
  await browser.page.locator('a:has-text("The deck as it stood")').first().click();
  await browser.page.waitForSelector('h1:has-text("The deck as it stood")', { timeout: 15_000 });
  // And a card: the heading renders from the run alone.
  await browser.page.waitForSelector('text=1.png', { timeout: 15_000 });
}

async function reachPrint(browser, base, scheme) {
  await reachDeckEditor(browser, base, `print-${scheme}`);
  await browser.click('a:has-text("Print this deck")');
  // Every deck has to be read before the options render, and axe reading the
  // spinner instead would report a screen with nothing on it as clean.
  await browser.page.waitForSelector('button:has-text("Generate PDF")', { timeout: 30_000 });
}

async function reachScene(browser, base, scheme) {
  await freshProject(browser, base, `scene-${scheme}`);
  await browser.click('a:has-text("Back to the project")');
  await browser.click('a:has-text("Blender scene")');
  // The project's decks and its file tree both land before the pickers render;
  // axe run against the spinner would call an empty screen clean.
  await browser.page.waitForSelector('button:has-text("Export bundle")', { timeout: 30_000 });
}

async function reachDeleted(browser, base, scheme) {
  const filename = await freshProject(browser, base, `deleted-${scheme}`);
  await browser.page.waitForSelector(`button[aria-label="Delete ${filename}"]`, {
    timeout: 15_000,
  });

  // Playwright dismisses a dialog nobody has claimed, so without this the
  // confirm is answered "no", the delete never happens, and axe reads an empty
  // screen while reporting green. Registered before the click, and the wait
  // afterwards is what turns a cancelled dialog into a failure.
  browser.page.once('dialog', (dialog) => dialog.accept());
  await browser.click(`button[aria-label="Delete ${filename}"]`);
  await browser.page.waitForSelector(`button[aria-label="Delete ${filename}"]`, {
    state: 'detached',
    timeout: 15_000,
  });

  await browser.click('a:has-text("Deleted")');
  // The restore controls appear only once the member roster has answered, so
  // waiting on one keeps axe from reading a half-drawn screen.
  await browser.page.waitForSelector(`button[aria-label="Restore ${filename}"]`, {
    timeout: 15_000,
  });
  await browser.page.waitForSelector(`button[aria-label="Permanently delete ${filename}"]`, {
    timeout: 15_000,
  });
}

async function run() {
  // The import routes are named alongside the shared list because the history
  // screens are reached by driving them, and an API that does not serve them
  // should say so here rather than inside a screen fifteen seconds later.
  const api = await inspectApi(API, [
    ['post', '/api/decks/{deckId}/import/runs'],
    ['post', '/api/decks/import/runs/{runId}/pages'],
    ['post', '/api/decks/import/runs/{runId}/finish'],
  ]);
  // Partial, because the three signed-out screens need no API at all and
  // check:all has to keep passing on a checkout with nothing else running.
  const refusal = probeRefusal('check:a11y', api, {
    skips: `${SCREENS.filter((screen) => screen.authed).length} screen(s) behind the session were not read`,
    partial: true,
  });
  if (refusal !== null) return refusal;

  const screens = SCREENS.filter((screen) => api.ok || !screen.authed);

  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    // /ws as well as /api: without it the app's socket opens against this
    // server, fails its handshake, and reconnects for the length of the run.
    server: {
      port: PORT,
      strictPort: false,
      proxy: { '/api': API, '/ws': { target: API, ws: true } },
    },
    logLevel: 'error',
  });
  await server.listen();
  const base = `http://localhost:${server.config.server.port ?? PORT}`;

  const failures = [];
  let cases = 0;

  for (const scheme of SCHEMES) {
    const browser = await createBrowser({ colorScheme: scheme });
    if (!browser) {
      await server.close();
      console.warn('[check:a11y] no browser engine available; skipping');
      return 0;
    }

    for (const screen of screens) {
      try {
        if (screen.reach) await screen.reach(browser, base, scheme);
        else await browser.goto(`${base}${screen.path}`, { wait: 250 });
      } catch (error) {
        // What the API said, not only which element never appeared: reaching a
        // screen drives the real app, and its request failing is the reason far
        // more often than the selector being wrong.
        const said = browser.serverErrors;
        throw new Error(
          `[check:a11y] could not reach ${screen.name} (${scheme}): ${error.message}` +
            (said.length > 0 ? `\n  the API answered: ${said.join(', ')}` : ''),
          { cause: error }
        );
      }
      await browser.page.addScriptTag({ content: axeSource });

      const result = await browser.page.evaluate(
        ([rules]) =>
          window.axe.run(document, {
            runOnly: { type: 'rule', values: rules },
            resultTypes: ['violations'],
          }),
        [RULES]
      );

      cases += 1;
      for (const violation of result.violations) {
        failures.push(
          `${screen.name} (${scheme}): ${violation.id} — ${violation.help} [${violation.nodes.length} node(s)]`
        );
      }
    }

    await browser.close();
  }

  await server.close();

  if (selftest) {
    // Sensitivity, not correctness. A check that measures nothing reports green
    // exactly like one that passes, so prove the rules can actually fire.
    console.log(`[selftest] ran ${cases} cases across ${SCHEMES.length} colour schemes`);
    if (cases !== screens.length * SCHEMES.length) {
      console.error('[selftest] FAILED: not every screen/scheme combination ran');
      return 1;
    }
    const planted = await plantedViolationIsCaught(PORT);
    if (!planted) {
      console.error('[selftest] FAILED: a deliberately broken page was not flagged');
      return 1;
    }
    console.log('[selftest] a deliberately broken page was flagged, as expected');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} accessibility violation(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    return 1;
  }

  const unread = (SCREENS.length - screens.length) * SCHEMES.length;
  console.log(
    `check:a11y passed (${cases} screen/scheme combinations` +
      (unread > 0 ? `; ${unread} SKIPPED for want of an API` : '') +
      ')'
  );
  return 0;
}

// Serves markup that violates two of the rules above and requires axe to say so.
async function plantedViolationIsCaught() {
  const browser = await createBrowser({ colorScheme: 'light' });
  if (!browser) return true;

  const html = `<!doctype html><html><body>
    <button></button>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  </body></html>`;

  await browser.goto(`data:text/html,${encodeURIComponent(html)}`);
  await browser.page.addScriptTag({ content: axeSource });

  const result = await browser.page.evaluate(
    ([rules]) =>
      window.axe.run(document, {
        runOnly: { type: 'rule', values: rules },
        resultTypes: ['violations'],
      }),
    [RULES]
  );
  await browser.close();

  // Names the rules it expects: with any violation accepted, an unrelated one
  // would pass for the planted bug being caught.
  const found = new Set(result.violations.map((violation) => violation.id));
  return found.has('button-name') && found.has('image-alt');
}

process.exit(await run());
