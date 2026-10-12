import { type ComponentKind, isComponentKind } from '@three-peaks/shared';

// A hand-rolled History router. The whole app is a handful of screens, and a
// discriminated-union Route means App.svelte switches exhaustively -- a new
// route that nothing renders is a compile error rather than a blank page.

export type Route =
  | { name: 'projects' }
  | { name: 'project'; params: { projectId: string } }
  | { name: 'assets'; params: { projectId: string; folderId: string | null } }
  | { name: 'components'; params: { projectId: string; kind: ComponentKind } }
  | { name: 'component'; params: { projectId: string; componentId: string } }
  | { name: 'members'; params: { projectId: string } }
  | { name: 'deleted'; params: { projectId: string } }
  | { name: 'decks'; params: { projectId: string } }
  | { name: 'deck'; params: { projectId: string; deckId: string } }
  | { name: 'deck-history'; params: { projectId: string; deckId: string } }
  | { name: 'deck-run'; params: { projectId: string; deckId: string; runId: string } }
  | { name: 'deck-as-of'; params: { projectId: string; deckId: string; runId: string } }
  | { name: 'print'; params: { projectId: string; deckId: string | null; boardId: string | null } }
  | { name: 'scene'; params: { projectId: string } }
  | { name: 'model'; params: { projectId: string; fileId: string } }
  | { name: 'versions'; params: { projectId: string; fileId: string } }
  | { name: 'account' }
  | { name: 'login' }
  | { name: 'signup' }
  | { name: 'forgot-password' }
  | { name: 'reset-password'; params: { token: string } }
  | { name: 'not-found' };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export function matchRoute(path: string, search = ''): Route {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once and discarded; nothing renders from it
  const params = new URLSearchParams(search);
  const clean = path.replace(/\/+$/, '') || '/';

  if (clean === '/' || clean === '/projects') return { name: 'projects' };
  if (clean === '/account') return { name: 'account' };
  if (clean === '/login') return { name: 'login' };
  if (clean === '/signup') return { name: 'signup' };
  if (clean === '/forgot-password') return { name: 'forgot-password' };
  if (clean === '/reset-password') {
    return { name: 'reset-password', params: { token: params.get('token') ?? '' } };
  }

  const members = new RegExp(`^/projects/(${UUID})/members$`).exec(clean);
  if (members) return { name: 'members', params: { projectId: members[1] } };

  const deleted = new RegExp(`^/projects/(${UUID})/deleted$`).exec(clean);
  if (deleted) return { name: 'deleted', params: { projectId: deleted[1] } };

  // Most specific first: every one of these is a prefix of the deck editor's
  // own path, and the as-of path is a prefix-extension of one run's.
  const deckAsOf = new RegExp(`^/projects/(${UUID})/decks/(${UUID})/runs/(${UUID})/deck$`).exec(
    clean
  );
  if (deckAsOf) {
    return {
      name: 'deck-as-of',
      params: { projectId: deckAsOf[1], deckId: deckAsOf[2], runId: deckAsOf[3] },
    };
  }

  const deckRun = new RegExp(`^/projects/(${UUID})/decks/(${UUID})/runs/(${UUID})$`).exec(clean);
  if (deckRun) {
    return {
      name: 'deck-run',
      params: { projectId: deckRun[1], deckId: deckRun[2], runId: deckRun[3] },
    };
  }

  const deckHistory = new RegExp(`^/projects/(${UUID})/decks/(${UUID})/history$`).exec(clean);
  if (deckHistory) {
    return { name: 'deck-history', params: { projectId: deckHistory[1], deckId: deckHistory[2] } };
  }

  const deck = new RegExp(`^/projects/(${UUID})/decks/(${UUID})$`).exec(clean);
  if (deck) return { name: 'deck', params: { projectId: deck[1], deckId: deck[2] } };

  const decks = new RegExp(`^/projects/(${UUID})/decks$`).exec(clean);
  if (decks) return { name: 'decks', params: { projectId: decks[1] } };

  const print = new RegExp(`^/projects/(${UUID})/print$`).exec(clean);
  if (print) {
    // A deck or a board named in the query arrives pre-selected, so "print
    // this" from its own screen is one click rather than a screen and then a
    // checkbox.
    const deckId = params.get('deck');
    const boardId = params.get('board');
    return {
      name: 'print',
      params: {
        projectId: print[1],
        deckId: deckId && deckId.length > 0 ? deckId : null,
        boardId: boardId && boardId.length > 0 ? boardId : null,
      },
    };
  }

  const scene = new RegExp(`^/projects/(${UUID})/scene$`).exec(clean);
  if (scene) return { name: 'scene', params: { projectId: scene[1] } };

  // A uuid is one component and a word is a section. Nothing else could be
  // either, so the two live under one path rather than under a `/kind/` segment
  // that would only exist to tell them apart.
  const component = new RegExp(`^/projects/(${UUID})/components/(${UUID})$`).exec(clean);
  if (component) {
    return { name: 'component', params: { projectId: component[1], componentId: component[2] } };
  }

  const section = new RegExp(`^/projects/(${UUID})/components/([a-z]+)$`).exec(clean);
  if (section && isComponentKind(section[2])) {
    return { name: 'components', params: { projectId: section[1], kind: section[2] } };
  }

  const model = new RegExp(`^/projects/(${UUID})/files/(${UUID})/3d$`).exec(clean);
  if (model) return { name: 'model', params: { projectId: model[1], fileId: model[2] } };

  const versions = new RegExp(`^/projects/(${UUID})/files/(${UUID})/versions$`).exec(clean);
  if (versions)
    return { name: 'versions', params: { projectId: versions[1], fileId: versions[2] } };

  const assets = new RegExp(`^/projects/(${UUID})/assets$`).exec(clean);
  if (assets) {
    const folderId = params.get('folder');
    return {
      name: 'assets',
      params: {
        projectId: assets[1],
        folderId: folderId && folderId.length > 0 ? folderId : null,
      },
    };
  }

  const project = new RegExp(`^/projects/(${UUID})$`).exec(clean);
  if (project) {
    // `?folder=` is how the explorer used to be addressed, and a bookmark or a
    // link in somebody's notes still says so. Reading it as Assets keeps those
    // working without a redirect hop.
    const folderId = params.get('folder');
    if (folderId && folderId.length > 0) {
      return { name: 'assets', params: { projectId: project[1], folderId } };
    }
    return { name: 'project', params: { projectId: project[1] } };
  }

  return { name: 'not-found' };
}

const MAX_REDIRECTS = 10;

class Router {
  current = $state.raw<Route>(matchRoute('/'));
  path = $state('/');

  // Returning a path from this redirects instead of navigating. It runs on
  // navigate() and on popstate but NOT on the initial page load -- the caller
  // has to guard that once, after the session store knows whether there is a
  // signed-in account.
  beforeNavigate: ((to: Route, path: string) => string | undefined | void) | null = null;

  start(): void {
    this.#apply(location.pathname + location.search, { push: false, guard: false });
    addEventListener('popstate', () => {
      this.#apply(location.pathname + location.search, { push: false, guard: true });
    });
  }

  navigate(path: string): void {
    this.#apply(path, { push: true, guard: true });
  }

  redirect(path: string): void {
    this.#apply(path, { push: false, guard: true, replace: true });
  }

  #apply(target: string, options: { push: boolean; guard: boolean; replace?: boolean }): void {
    let path = target;

    if (options.guard && this.beforeNavigate) {
      // Bounded: a pair of guards that each redirect to the other would
      // otherwise hang the tab with no stack to read.
      for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const [pathname, search = ''] = path.split('?');
        const redirected = this.beforeNavigate(matchRoute(pathname, search), path);
        if (typeof redirected !== 'string' || redirected === path) break;
        path = redirected;
        if (hop === MAX_REDIRECTS - 1) {
          throw new Error(`Redirect loop while navigating to ${target}`);
        }
      }
    }

    const [pathname, search = ''] = path.split('?');
    this.current = matchRoute(pathname, search);
    this.path = path;

    if (options.replace) history.replaceState({}, '', path);
    else if (options.push) history.pushState({}, '', path);
  }
}

export const router = new Router();

// Put this on an anchor, or on any container of anchors. It respects modifier
// keys, middle-click, target="_blank", downloads and external origins, so a
// link that should leave the app still does.
export function link(node: HTMLElement) {
  function onClick(event: MouseEvent) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = (event.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once inside the handler; nothing retains it
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;

    event.preventDefault();
    router.navigate(url.pathname + url.search);
  }

  node.addEventListener('click', onClick);
  return {
    destroy() {
      node.removeEventListener('click', onClick);
    },
  };
}
