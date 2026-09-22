import type { components } from '@three-peaks/shared/api';
import type { ComponentKind } from '@three-peaks/shared';
import { CliError, EXIT, assertOk } from './errors.ts';
import { configPath } from './config.ts';
import type { RuntimeContext } from './context.ts';
import type { Opts } from './kit.ts';

type Schemas = components['schemas'];

export type Project = Schemas['Project'];
export type Deck = Schemas['Deck'];
export type DeckWithCards = Schemas['DeckWithCards'];
export type DeckCard = DeckWithCards['cards'][number];
export type Component = Schemas['Component'];
export type FileRow = Schemas['File'];
export type Folder = Schemas['Folder'];
export type DirectoryListing = Schemas['DirectoryListing'];
export type DeletedEntry = Schemas['DeletedListing']['entries'][number];
export type Member = Schemas['ProjectMemberList']['members'][number];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ID_PREFIX_RE = /^[0-9a-f][0-9a-f-]{3,}$/;

// Four tiers, strongest first: the whole id, the exact name, an id prefix of at
// least four characters, then a unique substring of the name. A tier that
// matches more than one row stops the walk with the candidates rather than
// falling through to a weaker tier that might happen to pick one.
export function matchRefOrNull<T>(
  ref: string,
  items: readonly T[],
  kind: string,
  getId: (item: T) => string,
  getName: (item: T) => string
): T | null {
  const lower = ref.toLowerCase();
  const tiers: T[][] = [
    items.filter((item) => getId(item).toLowerCase() === lower),
    items.filter((item) => getName(item).toLowerCase() === lower),
    ID_PREFIX_RE.test(lower)
      ? items.filter((item) => getId(item).toLowerCase().startsWith(lower))
      : [],
    lower === '' ? [] : items.filter((item) => getName(item).toLowerCase().includes(lower)),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) {
      return tier[0];
    }
    if (tier.length > 1) {
      const candidates = tier
        .slice(0, 10)
        .map((item) => `  ${getId(item).slice(0, 8)}  ${getName(item)}`)
        .join('\n');
      throw new CliError(
        `Ambiguous ${kind} "${ref}"; use an id or a more specific name:\n${candidates}`,
        EXIT.usage
      );
    }
  }
  return null;
}

export function matchRef<T>(
  ref: string,
  items: readonly T[],
  kind: string,
  getId: (item: T) => string,
  getName: (item: T) => string
): T {
  const match = matchRefOrNull(ref, items, kind, getId, getName);
  if (match === null) {
    throw new CliError(`No ${kind} matching "${ref}"`, EXIT.notFound);
  }
  return match;
}

// --- Projects ----------------------------------------------------------------

export async function listProjects(ctx: RuntimeContext): Promise<Project[]> {
  return assertOk(await ctx.api.GET('/api/projects')).projects;
}

type ProjectRef = { value: string; source: 'argument' | 'env' | 'config' };

function projectRef(ctx: RuntimeContext, ref?: string): ProjectRef | null {
  const chosen: ProjectRef | null =
    ref != null
      ? { value: ref, source: 'argument' }
      : ctx.deps.env.THREEPEAKS_PROJECT != null
        ? { value: ctx.deps.env.THREEPEAKS_PROJECT, source: 'env' }
        : ctx.config.default_project != null
          ? { value: ctx.config.default_project, source: 'config' }
          : null;
  return chosen === null || chosen.value === '' ? null : chosen;
}

export function effectiveProjectRef(ctx: RuntimeContext, ref?: string): string {
  const chosen = projectRef(ctx, ref);
  if (chosen === null) {
    throw new CliError(
      'No project specified; pass --project, set THREEPEAKS_PROJECT, or run: threepeaks config set default-project <project>',
      EXIT.usage
    );
  }
  return chosen.value;
}

export function matchProject<T extends { id: string; name: string }>(
  ref: string,
  projects: readonly T[]
): T {
  return matchRef(
    ref,
    projects,
    'project',
    (p) => p.id,
    (p) => p.name
  );
}

export async function resolveProject(ctx: RuntimeContext, ref?: string): Promise<Project> {
  const chosen = projectRef(ctx, ref);
  const value = effectiveProjectRef(ctx, ref);
  const match = matchRefOrNull(
    value,
    await listProjects(ctx),
    'project',
    (p) => p.id,
    (p) => p.name
  );
  if (match !== null) {
    return match;
  }
  // A ref the caller never typed has to say where it came from, or the id in the
  // message looks like the CLI's own invention.
  const origin =
    chosen?.source === 'config'
      ? `; it is the default-project in ${configPath(ctx.configDir)} — replace it with "threepeaks config set default-project <project>" or drop it with "threepeaks config unset default-project"`
      : chosen?.source === 'env'
        ? '; it is the value of THREEPEAKS_PROJECT'
        : '';
  throw new CliError(`No project matching "${value}"${origin}`, EXIT.notFound);
}

// Every command that works inside a project takes `--project`, and this is the
// one reading of it.
export async function projectFromOpts(ctx: RuntimeContext, opts: Opts): Promise<Project> {
  return resolveProject(ctx, typeof opts.project === 'string' ? opts.project : undefined);
}

export function assertEditor(project: Project): void {
  if (project.role !== 'editor') {
    throw new CliError(
      `You are a viewer on "${project.name}"; only an editor can change it`,
      EXIT.forbidden
    );
  }
}

export async function listMembers(ctx: RuntimeContext, projectId: string): Promise<Member[]> {
  return assertOk(
    await ctx.api.GET('/api/projects/{id}/members', { params: { path: { id: projectId } } })
  ).members;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// An address is matched whole and first, because it is the one field a member
// row carries that is unique by construction; a name need not be.
export function matchMember(ref: string, members: readonly Member[]): Member {
  if (EMAIL_RE.test(ref)) {
    const byEmail = members.find((m) => m.email.toLowerCase() === ref.toLowerCase());
    if (byEmail !== undefined) return byEmail;
  }
  return matchRef(
    ref,
    members,
    'member',
    (m) => m.user_id,
    (m) => m.name
  );
}

// --- Decks ---------------------------------------------------------------------

export async function listDecks(ctx: RuntimeContext, projectId: string): Promise<Deck[]> {
  return assertOk(await ctx.api.GET('/api/decks', { params: { query: { project_id: projectId } } }))
    .decks;
}

export async function fetchDeck(ctx: RuntimeContext, deckId: string): Promise<DeckWithCards> {
  return assertOk(await ctx.api.GET('/api/decks/{deckId}', { params: { path: { deckId } } }));
}

export async function resolveDeck(
  ctx: RuntimeContext,
  projectId: string,
  ref: string
): Promise<Deck> {
  return matchRef(
    ref,
    await listDecks(ctx, projectId),
    'deck',
    (d) => d.id,
    (d) => d.name
  );
}

// A card is named by its image: the file id, or the filename the deck shows.
// Cards whose image is deleted are included, because a tombstoned card is one
// the deck still holds a place for and may be named.
export function matchCard(deck: DeckWithCards, ref: string): DeckCard {
  return matchRef(
    ref,
    deck.cards,
    `card in "${deck.deck.name}"`,
    (c) => c.file_id,
    (c) => c.file.filename
  );
}

// --- Components -------------------------------------------------------------

export async function listComponents(
  ctx: RuntimeContext,
  projectId: string,
  kind?: ComponentKind
): Promise<Component[]> {
  return assertOk(
    await ctx.api.GET('/api/components', {
      params: { query: { project_id: projectId, ...(kind === undefined ? {} : { kind }) } },
    })
  ).components;
}

export async function resolveComponent(
  ctx: RuntimeContext,
  projectId: string,
  ref: string
): Promise<Component> {
  return matchRef(
    ref,
    await listComponents(ctx, projectId),
    'component',
    (c) => c.id,
    (c) => c.name
  );
}

// --- The folder tree (Assets) ----------------------------------------------

export async function fetchDirectory(
  ctx: RuntimeContext,
  projectId: string,
  folderId: string | null
): Promise<DirectoryListing> {
  return assertOk(
    await ctx.api.GET('/api/files/directory', {
      params: {
        query: { project_id: projectId, ...(folderId === null ? {} : { folder_id: folderId }) },
      },
    })
  );
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

export interface ResolvedFolder {
  // Null is the Assets root, which has no row.
  folder: Folder | null;
  listing: DirectoryListing;
}

// Folder names are unique within a directory compared case-insensitively, so a
// segment is matched whole and without the substring tier: a path is something
// someone typed deliberately, and `rm Art` must not reach "Artwork".
export async function resolveFolderPath(
  ctx: RuntimeContext,
  projectId: string,
  path: string
): Promise<ResolvedFolder> {
  if (UUID_RE.test(path)) {
    const listing = await fetchDirectory(ctx, projectId, path);
    return { folder: listing.folder, listing };
  }
  let listing = await fetchDirectory(ctx, projectId, null);
  let folder: Folder | null = null;
  const walked: string[] = [];
  for (const segment of splitPath(path)) {
    const next = listing.folders.find((f) => f.name.toLowerCase() === segment.toLowerCase());
    walked.push(segment);
    if (next === undefined) {
      throw new CliError(`No folder "${walked.join('/')}" in Assets`, EXIT.notFound);
    }
    folder = next;
    listing = await fetchDirectory(ctx, projectId, next.id);
  }
  return { folder, listing };
}

export function folderPathOf(listing: DirectoryListing): string {
  return listing.breadcrumb.map((crumb) => crumb.name).join('/');
}

// --- Files ---------------------------------------------------------------------

export async function fetchFile(ctx: RuntimeContext, fileId: string): Promise<FileRow> {
  return assertOk(await ctx.api.GET('/api/files/{id}', { params: { path: { id: fileId } } }));
}

export interface FileScope {
  deck?: string;
  component?: string;
}

export function fileScopeFromOpts(opts: Opts): FileScope {
  const deck = typeof opts.deck === 'string' ? opts.deck : undefined;
  const component = typeof opts.component === 'string' ? opts.component : undefined;
  if (deck !== undefined && component !== undefined) {
    throw new CliError('Pass --deck or --component, not both', EXIT.usage);
  }
  return { deck, component };
}

// Where a file reference is looked up. A whole id needs no scope and no project;
// anything else is a name within one home -- a deck's cards, a component's
// files (by role or by name), or a path in the Assets tree.
export async function resolveFileRef(
  ctx: RuntimeContext,
  ref: string,
  scope: FileScope,
  projectRef?: string
): Promise<FileRow> {
  if (UUID_RE.test(ref)) {
    return fetchFile(ctx, ref);
  }
  const project = await resolveProject(ctx, projectRef);
  if (scope.deck !== undefined) {
    const deck = await resolveDeck(ctx, project.id, scope.deck);
    return matchCard(await fetchDeck(ctx, deck.id), ref).file;
  }
  if (scope.component !== undefined) {
    const component = await resolveComponent(ctx, project.id, scope.component);
    const byRole = component.files.find((entry) => entry.role === ref.toLowerCase());
    if (byRole !== undefined) return byRole.file;
    return matchRef(
      ref,
      component.files.map((entry) => entry.file),
      `file in "${component.name}"`,
      (f) => f.id,
      (f) => f.filename
    );
  }
  const segments = splitPath(ref);
  const name = segments.pop();
  if (name === undefined) {
    throw new CliError('Name a file, not the Assets root', EXIT.usage);
  }
  const { listing } = await resolveFolderPath(ctx, project.id, segments.join('/'));
  const where = segments.length === 0 ? 'Assets' : `Assets/${segments.join('/')}`;
  return matchRef(
    name,
    listing.files,
    `file in ${where}`,
    (f) => f.id,
    (f) => f.filename
  );
}

// --- The deleted listing ----------------------------------------------------

export async function listDeleted(ctx: RuntimeContext, projectId: string): Promise<DeletedEntry[]> {
  return assertOk(
    await ctx.api.GET('/api/files/deleted', { params: { query: { project_id: projectId } } })
  ).entries;
}

// `path` is where the entry came from -- a folder trail, or the deck or
// component that held it -- and never includes the entry's own name.
export function deletedPath(entry: DeletedEntry): string {
  return entry.path === '' ? entry.name : `${entry.path}/${entry.name}`;
}

export function matchDeleted(ref: string, entries: readonly DeletedEntry[]): DeletedEntry {
  // The whole path first: two tombstones can share a name in different
  // folders, and the path is the one spelling the listing prints that tells
  // them apart.
  const byPath = entries.filter((e) => deletedPath(e).toLowerCase() === ref.toLowerCase());
  if (byPath.length === 1) return byPath[0];
  return matchRef(
    ref,
    entries,
    'deleted entry',
    (e) => e.id,
    (e) => e.name
  );
}
