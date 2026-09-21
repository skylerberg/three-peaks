// Signing up and creating a project, driven through the real forms. Two probes
// need an authenticated screen to look at, and neither should be the one that
// owns how an account comes into being.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The routes these probes drive, named the way the spec names them. `/health`
// answers 200 from whatever holds the port -- on one machine that was a sibling
// project's API, and on the same machine a copy of this one started before the
// studio's cold-load route existed and never restarted. Both left a probe
// failing fifteen seconds later inside a screen with nothing to say about why,
// so the port is asked what it is and what it serves before a browser starts.
const REQUIRED_PATHS = [
  ['post', '/api/auth/signup'],
  ['post', '/api/projects'],
  ['post', '/api/files/upload'],
  ['get', '/api/files/directory'],
  ['get', '/api/files/{id}'],
  ['get', '/api/files/{id}/versions'],
];

const APP_NAME = 'three-peaks';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

// Read the way apps/api/src/config/buildInfo.ts reads it, so the two answers are
// comparable at all. A detached HEAD names nothing -- which is what a CI
// checkout is -- and counts as unknown rather than as a name free to disagree.
function checkoutBranch() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Three outcomes, because they call for three different things: `ok` runs the
 * probe, `absent` is the local convenience of a checkout with nothing running,
 * and the third -- something is there and it is not this build -- is a failure
 * wherever it happens. Skipping that one would report a pass for a gate that
 * measured nothing; proceeding is the fifteen-second mystery this replaces.
 *
 * `also` names the routes one probe needs and the others do not, in the same
 * `[method, path]` shape. They belong to the caller rather than to the shared
 * list: a route only one probe drives should fail in that probe, by name, and
 * not make every other one refuse an API that serves them perfectly well.
 */
export async function inspectApi(api, also = []) {
  let root;
  try {
    root = await fetch(`${api}/`);
  } catch {
    return { ok: false, absent: true, reason: `no API at ${api}` };
  }

  if (!root.ok) {
    return { ok: false, absent: true, reason: `no API at ${api} (GET / answered ${root.status})` };
  }

  const identity = await root.json().catch(() => ({}));
  if (identity.name !== APP_NAME) {
    return {
      ok: false,
      absent: false,
      reason:
        `the server at ${api} is not this API: GET / named ` +
        `${JSON.stringify(identity.name ?? null)}, expected ${JSON.stringify(APP_NAME)}. ` +
        'Point API_PROXY_TARGET at this checkout.',
    };
  }

  // Two worktrees on two ports answer to the same name and serve the same
  // routes, so nothing above can tell them apart -- and the port is first come,
  // first served, which means the one that answers may be a branch nobody here
  // is working on. /health names the build for exactly this reason; asking it
  // now is the difference between a refusal and a green run against somebody
  // else's code.
  const here = checkoutBranch();
  const there = identity.branch?.trim() || null;
  if (here && there && here !== there) {
    return {
      ok: false,
      absent: false,
      reason:
        `the API at ${api} is serving branch ${JSON.stringify(there)} ` +
        `(${identity.commit ?? 'commit unknown'}), and this checkout is on ` +
        `${JSON.stringify(here)}. Start one from here, or point API_PROXY_TARGET at ` +
        'the port this branch already holds.',
    };
  }

  const response = await fetch(`${api}/api/openapi.json`);
  const spec = response.ok ? await response.json().catch(() => ({})) : {};
  const missing = [...REQUIRED_PATHS, ...also].filter(
    ([method, path]) => spec.paths?.[path]?.[method] === undefined
  );
  if (missing.length > 0) {
    return {
      ok: false,
      absent: false,
      reason:
        `the API at ${api} is older than this checkout: it does not serve ` +
        `${missing.map(([method, path]) => `${method.toUpperCase()} ${path}`).join(', ')}. ` +
        'Restart it.',
    };
  }

  return { ok: true, absent: false, reason: '' };
}

/**
 * What a probe does about the API it was handed, in one place rather than in
 * five copies free to drift: something there that is not this build fails
 * wherever it happens, an absent one is the local convenience of a checkout
 * with nothing running, and `REQUIRE_PROBES=1` says this is a run where a skip
 * is a broken gate rather than a kindness -- which is what to set when the gate
 * is being trusted rather than iterated against.
 *
 * Returns the exit code to return, or null to carry on. `partial` belongs to a
 * probe that still measures something without an API: check:a11y has three
 * signed-out screens, and it is handed null once the warning is printed.
 */
export function probeRefusal(name, api, { skips = 'nothing was measured', partial = false } = {}) {
  if (api.ok) return null;

  const message = `[${name}] ${api.reason}`;
  if (!api.absent) {
    console.error(message);
    return 1;
  }

  const required = process.env.CI ? 'CI' : process.env.REQUIRE_PROBES ? 'REQUIRE_PROBES' : null;
  if (required) {
    console.error(`${message}; refusing to skip under ${required}`);
    return 1;
  }

  // One token, the same in every probe, so a gate log that scrolled past this
  // still answers `grep SKIPPED` afterwards.
  console.warn(
    `[${name}] SKIPPED \u2014 ${api.reason}; ${skips}. Start one with \`pnpm dev:api\`.`
  );
  return partial ? null : 0;
}

// A fresh throwaway account per run: the probes upload files and save models,
// and a shared one would accumulate both until a quota check started failing
// for reasons that have nothing to do with the change under test.
export async function signUp(browser, base, { name, stamp }) {
  const email = `probe-${stamp}@example.test`;
  const password = 'correct horse battery staple';

  await browser.goto(`${base}/signup`, { wait: 300 });
  await browser.page.fill('input[autocomplete="name"]', name);
  await browser.page.fill('input[type="email"]', email);
  await browser.page.fill('input[type="password"]', password);
  await browser.click('button[type="submit"]');
  await browser.page.waitForSelector('text=Projects', { timeout: 10_000 });

  return { email, password };
}

// One browser context serves every screen of a colour scheme, and the session
// guard bounces an already-signed-in visitor straight off /signup -- where the
// next signUp's page.fill then waits for a field that is not there. Signing out
// first makes each authenticated screen independent of the order they run in.
//
// Through the real control rather than by emptying localStorage: init() adopts
// the stored token and writes it back, so a clear that lands mid-boot is undone
// a moment later.
export async function signOut(browser, base) {
  // Asked for on a public route: the guard remembers where a signed-out visitor
  // was headed and sends them back to it after the next sign-up, so probing for
  // a session on /account is what lands the account screen instead of Projects.
  await browser.goto(`${base}/login`, { wait: 0 });
  const signedIn = await browser.page.evaluate(() => localStorage.getItem('tph.token') !== null);
  if (!signedIn) return;

  await browser.goto(`${base}/account`, { wait: 0 });
  await browser.page.waitForSelector('button:has-text("Sign out")', { timeout: 10_000 });
  await browser.click('button:has-text("Sign out")');
  await browser.page.waitForSelector('h1:has-text("Sign in")', { timeout: 10_000 });
}

export async function createProject(browser, projectName) {
  await browser.click('button:has-text("New project")');
  await browser.page.fill('input[placeholder="Colori"]', projectName);
  await browser.click('button[type="submit"]');
  await browser.page.waitForSelector(`a:has-text("${projectName}")`, { timeout: 10_000 });
  await browser.click(`a:has-text("${projectName}")`);
  // The project screen is a list of sections, so this leaves the browser at the
  // way in to all of them rather than inside one.
  await browser.page.waitForSelector('a:has-text("Assets")', { timeout: 10_000 });
}

// The file explorer, which is one section among the others: what belongs to no
// deck and no component.
export async function openAssets(browser) {
  await browser.click('a:has-text("Assets")');
  await browser.page.waitForSelector('button:has-text("Upload files")', { timeout: 10_000 });
}
