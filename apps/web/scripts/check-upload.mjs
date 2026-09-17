// Drives the real file-upload path in a real browser, against a real API.
//
// jsdom models none of what this asserts: there is no file picker, no
// DataTransfer, and no streaming request body. The unit tests can prove the
// store calls fetch; only this can prove that picking a file in the UI puts
// bytes in the project and draws them back.
//
// It needs an API. Point API_PROXY_TARGET at one (default localhost:17310) and
// it will sign up its own throwaway account.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createBrowser } from './lib/browser.mjs';
import { TINY_PNG } from './lib/fixtures.mjs';
import { createProject, inspectApi, openAssets, probeRefusal, signUp } from './lib/session.mjs';

const PORT = Number(process.env.UPLOAD_PROBE_PORT ?? 17331);
const API = process.env.API_PROXY_TARGET ?? 'http://localhost:17310';
const selftest = process.argv.includes('--selftest');

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

async function run() {
  const api = await inspectApi(API);
  const refusal = probeRefusal('check:upload', api);
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
    console.warn('[check:upload] no browser engine available; skipping');
    return 0;
  }

  try {
    await signUp(browser, base, { name: 'Upload Probe', stamp: Date.now() });
    check('signing up lands on the projects screen', true);

    await createProject(browser, 'Probe Project');
    await openAssets(browser);
    check('a created project appears in the list', true);

    // --- upload through the real file input --------------------------------
    const dir = mkdtempSync(join(tmpdir(), 'tph-upload-'));
    const filePath = join(dir, 'probe-card.txt');
    const contents = 'Ace of coins, value 3.';
    writeFileSync(filePath, contents);

    // setInputFiles is the real picker's effect; there is no way to reach this
    // path from jsdom at all.
    await browser.setInputFiles('input[type="file"]', filePath);
    // The download control, not the filename: the explorer draws the name on an
    // optimistic row the moment the upload starts, so waiting for the text
    // waits for nothing and every assertion below it then races the transfer.
    // Only a row from a real listing offers to fetch the stored bytes.
    await browser.page.waitForSelector('button[aria-label="Download probe-card.txt"]', {
      timeout: 15_000,
    });
    check('the uploaded file is drawn in the explorer', true);

    // The row is not proof the bytes arrived. Read them back through the API,
    // which is the only thing that can tell an optimistic row from a stored file.
    const stored = await browser.page.evaluate(async () => {
      const token = localStorage.getItem('tph.token');
      const list = await fetch(location.pathname.replace(/.*/, '/api/projects'), {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      const projectId = list.projects[0].id;
      const dir = await fetch(`/api/files/directory?project_id=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      const file = dir.files[0];
      const body = await fetch(`/api/files/${file.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.text());
      return { filename: file.filename, byteSize: file.byte_size, body };
    });

    check(
      'the stored filename is what was picked',
      stored.filename === 'probe-card.txt',
      stored.filename
    );
    check('the stored bytes are the file’s own', stored.body === contents, stored.body);
    check(
      'the recorded size matches the bytes',
      stored.byteSize === contents.length,
      `${stored.byteSize} vs ${contents.length}`
    );

    // --- the Download control actually downloads ---------------------------
    // Clicked, not merely present. Everything downstream of the click -- the
    // authorized fetch, the object URL, and how long it has to stay alive for
    // the browser to read it -- exists only in a real engine, and a revoke that
    // races that read produces a control that does nothing at all.
    const saved = await Promise.all([
      browser.page.waitForEvent('download', { timeout: 15_000 }),
      browser.click('button[aria-label="Download probe-card.txt"]'),
    ])
      .then(async ([download]) => {
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return { name: download.suggestedFilename(), body: Buffer.concat(chunks).toString() };
      })
      .catch((error) => ({ name: null, body: null, detail: error.message }));

    check(
      'clicking Download saves the file under its own name',
      saved.name === 'probe-card.txt',
      saved.detail ?? String(saved.name)
    );
    check(
      'the downloaded bytes are the ones that were uploaded',
      saved.body === contents,
      saved.detail ?? String(saved.body)
    );

    // --- an image row draws its thumbnail ----------------------------------
    // The bytes are behind the bearer credential, so a row cannot simply name
    // them in an `<img src>`: a request the browser starts carries no
    // Authorization header, and every thumbnail in the explorer answered 401
    // while it did. What replaces it -- an authorized fetch, an object URL, and
    // an <img> that decodes it -- only exists in a real engine.
    const pngPath = join(dir, 'probe-art.png');
    writeFileSync(pngPath, TINY_PNG);
    await browser.setInputFiles('input[type="file"]', pngPath);
    await browser.page.waitForSelector('button[aria-label="Download probe-art.png"]', {
      timeout: 15_000,
    });

    const thumbnail = await browser.page
      .waitForFunction(
        () => {
          const image = document.querySelector('li img');
          // naturalWidth, not merely a src: it says the engine decoded the
          // bytes, which a 401 body would never have got as far as.
          return image?.src.startsWith('blob:') && image.naturalWidth > 0 ? 'decoded' : null;
        },
        { timeout: 15_000 }
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    check(
      'an image row draws a thumbnail from bytes it was allowed to read',
      thumbnail === 'decoded',
      'no <img> with decoded blob bytes appeared within fifteen seconds'
    );

    // --- the quota meter reflects the upload -------------------------------
    // Waited for, not sampled. The meter is drawn from the listing that the
    // refresh after the upload fetches, which is a second round trip -- reading
    // it once raced that refresh and failed about one run in three, for no
    // reason to do with the code under test.
    const usedText = await browser.page
      .waitForFunction(
        () => {
          const match = document.body.innerText.match(/[\d.]+ [KMGT]?B of .+ used/);
          return match && !match[0].startsWith('0 B of') ? match[0] : null;
        },
        { timeout: 15_000 }
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null);

    check(
      'the storage meter shows a non-zero total',
      usedText !== null,
      'still read 0 B fifteen seconds after the upload'
    );

    if (selftest) {
      // Sensitivity: the same assertions run against a file that was never
      // uploaded must FAIL. Without this arm, a selector that stopped matching
      // would look exactly like a passing check.
      console.log('\n[selftest] the same assertions against a file that was never uploaded:');
      const absent = await browser.page
        .waitForSelector('text=never-uploaded.txt', { timeout: 1500 })
        .then(() => true)
        .catch(() => false);
      if (absent) {
        console.error('[selftest] FAILED: matched a file that does not exist');
        return 1;
      }
      console.log('  ok   a file that was never uploaded is not drawn');
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`);
    return 1;
  }
  console.log('\ncheck:upload passed');
  return 0;
}

process.exit(await run());
