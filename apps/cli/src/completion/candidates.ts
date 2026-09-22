import { createHash } from 'node:crypto';
import { assertOk } from '../errors.ts';
import {
  deletedPath,
  effectiveProjectRef,
  fetchDeck,
  fetchDirectory,
  listComponents,
  listDecks,
  listDeleted,
  listMembers,
  listProjects,
  matchProject,
  matchRef,
  splitPath,
  type DirectoryListing,
} from '../resolve.ts';
import { readCached, writeCached } from './cache.ts';
import type { RuntimeContext } from '../context.ts';
import type { Candidate, CompletionPlan, PlanScope } from './plan.ts';

interface NamedRef {
  id: string;
  name: string;
}

// Reference resolution is case-insensitive, so names that collide under that
// comparison would be rejected as ambiguous; offer short ids instead.
function toCandidates(items: readonly NamedRef[]): Candidate[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return items.map((item) =>
    (counts.get(item.name.toLowerCase()) ?? 0) > 1
      ? { value: item.id.slice(0, 8), description: item.name }
      : { value: item.name, description: item.id.slice(0, 8) }
  );
}

// The token is part of the key so a cache written by another account is never served.
function cacheKey(ctx: RuntimeContext, suffix: string): string {
  const fingerprint = createHash('sha256')
    .update(ctx.token ?? '')
    .digest('hex')
    .slice(0, 12);
  return `${fingerprint}|${ctx.baseUrl}|${suffix}`;
}

async function cached<T>(ctx: RuntimeContext, suffix: string, load: () => Promise<T>): Promise<T> {
  const key = cacheKey(ctx, suffix);
  const hit = await readCached<T>(ctx.configDir, key);
  if (hit != null) {
    return hit;
  }
  const value = await load();
  try {
    await writeCached(ctx.configDir, key, value);
  } catch {
    // An unwritable cache must not cost the user the candidates already in hand.
  }
  return value;
}

async function projects(ctx: RuntimeContext): Promise<NamedRef[]> {
  return cached(ctx, 'projects', async () =>
    (await listProjects(ctx)).map((p) => ({ id: p.id, name: p.name }))
  );
}

async function projectId(ctx: RuntimeContext, scope: PlanScope): Promise<string> {
  return matchProject(effectiveProjectRef(ctx, scope.project), await projects(ctx)).id;
}

async function decks(ctx: RuntimeContext, project: string): Promise<NamedRef[]> {
  return cached(ctx, `decks:${project}`, async () =>
    (await listDecks(ctx, project)).map((d) => ({ id: d.id, name: d.name }))
  );
}

async function deckId(ctx: RuntimeContext, scope: PlanScope): Promise<string | null> {
  if (scope.deck === undefined) return null;
  const project = await projectId(ctx, scope);
  return matchRef(
    scope.deck,
    await decks(ctx, project),
    'deck',
    (d) => d.id,
    (d) => d.name
  ).id;
}

async function cards(ctx: RuntimeContext, deck: string): Promise<Candidate[]> {
  return cached(ctx, `cards:${deck}`, async () =>
    toCandidates(
      (await fetchDeck(ctx, deck)).cards
        .filter((card) => card.file.deleted_at === null)
        .map((card) => ({ id: card.file_id, name: card.file.filename }))
    )
  );
}

async function components(ctx: RuntimeContext, project: string): Promise<NamedRef[]> {
  return cached(ctx, `components:${project}`, async () =>
    (await listComponents(ctx, project)).map((c) => ({ id: c.id, name: c.name }))
  );
}

async function componentFiles(
  ctx: RuntimeContext,
  project: string,
  ref: string
): Promise<Candidate[]> {
  const listed = await listComponents(ctx, project);
  const component = matchRef(
    ref,
    listed,
    'component',
    (c) => c.id,
    (c) => c.name
  );
  return component.files.map((entry) => ({
    value: entry.role,
    description: entry.file.filename,
  }));
}

// One directory at a time, the one the word typed so far is inside: a path is
// completed segment by segment, the way a shell completes one on disk.
async function assetPaths(
  ctx: RuntimeContext,
  project: string,
  current: string,
  withFiles: boolean
): Promise<Candidate[]> {
  const slash = current.lastIndexOf('/');
  const dir = slash === -1 ? '' : current.slice(0, slash);
  const listing = await cached(ctx, `dir:${project}:${dir.toLowerCase()}`, async () => {
    let at: DirectoryListing = await fetchDirectory(ctx, project, null);
    for (const segment of splitPath(dir)) {
      const next = at.folders.find((f) => f.name.toLowerCase() === segment.toLowerCase());
      if (next === undefined) return null;
      at = await fetchDirectory(ctx, project, next.id);
    }
    return at;
  });
  if (listing === null) return [];
  const prefix = dir === '' ? '' : `${dir}/`;
  return [
    ...listing.folders.map((f) => ({ value: `${prefix}${f.name}/`, description: 'folder' })),
    ...(withFiles
      ? listing.files.map((f) => ({
          value: `${prefix}${f.filename}`,
          description: f.id.slice(0, 8),
        }))
      : []),
  ];
}

export async function candidatesFor(
  ctx: RuntimeContext,
  plan: CompletionPlan,
  current: string
): Promise<Candidate[]> {
  if (plan.kind !== 'values') {
    return [];
  }
  const { scope } = plan;
  switch (plan.valueKind) {
    case 'project':
      return toCandidates(await projects(ctx));
    case 'token':
      return toCandidates(assertOk(await ctx.api.GET('/api/auth/tokens')).personal_access_tokens);
    case 'session':
      return assertOk(await ctx.api.GET('/api/auth/sessions')).sessions.map((s) => ({
        value: s.id.slice(0, 8),
        description: `${s.current ? 'this session, ' : ''}${s.user_agent ?? 'unknown client'}`,
      }));
    case 'link':
      return assertOk(await ctx.api.GET('/api/canva-app/links')).links.map((l) => ({
        value: l.id.slice(0, 8),
        description: `linked ${l.created_at.slice(0, 10)}`,
      }));
    default:
      break;
  }

  const project = await projectId(ctx, scope);
  switch (plan.valueKind) {
    case 'deck':
      return toCandidates(await decks(ctx, project));
    case 'component':
      return toCandidates(await components(ctx, project));
    case 'member':
      return (await listMembers(ctx, project)).map((m) => ({
        value: m.email,
        description: m.name,
      }));
    case 'entry':
      return (await listDeleted(ctx, project)).map((e) => ({
        value: deletedPath(e),
        description: `${e.kind} ${e.id.slice(0, 8)}`,
      }));
    case 'card': {
      const deck = await deckId(ctx, scope);
      return deck === null ? [] : cards(ctx, deck);
    }
    case 'run': {
      const deck = await deckId(ctx, scope);
      if (deck === null) return [];
      const { runs } = assertOk(
        await ctx.api.GET('/api/decks/{deckId}/import/runs', { params: { path: { deckId: deck } } })
      );
      return [
        { value: 'latest', description: 'the newest run' },
        ...runs.map((r) => ({
          value: r.id.slice(0, 8),
          description: `${r.status} ${r.started_at.slice(0, 16).replace('T', ' ')}`,
        })),
      ];
    }
    case 'folder':
      return assetPaths(ctx, project, current, false);
    case 'file': {
      if (scope.component !== undefined) return componentFiles(ctx, project, scope.component);
      const deck = await deckId(ctx, scope);
      if (deck !== null) return cards(ctx, deck);
      return assetPaths(ctx, project, current, true);
    }
    default:
      return [];
  }
}
