import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLiveCard, type CardFields } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { ApiError, CliError, EXIT, assertOk, exitCodeForStatus, toApiError } from './errors.ts';
import { readAllStdin } from './prompt.ts';
import {
  fetchDirectory,
  fetchFile,
  folderPathOf,
  matchRef,
  resolveFileRef,
  fetchDeck,
  type DeckCard,
  type DeckWithCards,
  type Project,
} from './resolve.ts';
import { cardsInput, safeFilename } from './decks.ts';
import type { RuntimeContext } from './context.ts';

type Schemas = components['schemas'];
export type Layout = Schemas['CardLayout'];
export type LayoutWithDecks = Schemas['CardLayoutWithDecks'];
export type CardContent = Schemas['CardContentList']['cards'][number];
type FileRow = Schemas['File'];

// --- Reading ---------------------------------------------------------------

// Cast, not converted: openapi-fetch's response mapping widens the box tuple
// to number[], and the named schema it came from says [x, y, width, height].
// Both are read off the same generated file, so the two cannot disagree.
export async function listLayouts(ctx: RuntimeContext, projectId: string): Promise<Layout[]> {
  const list = assertOk(
    await ctx.api.GET('/api/layouts', { params: { query: { project_id: projectId } } })
  );
  return list.layouts as Layout[];
}

export async function fetchLayout(ctx: RuntimeContext, layoutId: string): Promise<LayoutWithDecks> {
  const detail = assertOk(
    await ctx.api.GET('/api/layouts/{layoutId}', { params: { path: { layoutId } } })
  );
  return detail as LayoutWithDecks;
}

export function matchLayout(ref: string, layouts: readonly Layout[]): Layout {
  return matchRef(
    ref,
    layouts,
    'layout',
    (layout) => layout.id,
    (layout) => layout.name
  );
}

export async function resolveLayout(
  ctx: RuntimeContext,
  projectId: string,
  ref: string
): Promise<Layout> {
  return matchLayout(ref, await listLayouts(ctx, projectId));
}

export async function listCardContent(ctx: RuntimeContext, deckId: string): Promise<CardContent[]> {
  return assertOk(
    await ctx.api.GET('/api/card-content', { params: { query: { deck_id: deckId } } })
  ).cards;
}

// A layout file or a cards file, or stdin for `-`.
export async function readSource(ctx: RuntimeContext, path: string): Promise<string> {
  if (path === '-') return readAllStdin(ctx);
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${(err as Error).message}`, EXIT.usage);
  }
}

// --- Naming files --------------------------------------------------------------

// A written file reference -- an Assets path or an id -- to the id it names.
// Each reference is looked up once per run, however many cards repeat it.
export function fileResolver(
  ctx: RuntimeContext,
  project: Project
): (ref: string, what: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (ref, what) => {
    let pending = cache.get(ref);
    if (pending === undefined) {
      pending = resolveFileRef(ctx, ref, {}, project.id).then(
        (file) => file.id,
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new CliError(
            `${what}: ${ref}: ${message}`,
            err instanceof CliError ? err.exitCode : EXIT.notFound
          );
        }
      );
      cache.set(ref, pending);
    }
    return pending;
  };
}

// The other direction, for writing a file a person will edit: a file in Assets
// by its path, anything else by its id.
export function fileNamer(ctx: RuntimeContext): (id: string) => Promise<string> {
  const folders = new Map<string, Promise<string>>();
  const names = new Map<string, Promise<string>>();
  const folderPath = (file: FileRow) => {
    const key = file.folder_id ?? '';
    let pending = folders.get(key);
    if (pending === undefined) {
      pending =
        file.folder_id === null
          ? Promise.resolve('')
          : fetchDirectory(ctx, file.project_id, file.folder_id).then(folderPathOf);
      folders.set(key, pending);
    }
    return pending;
  };
  return (id) => {
    let pending = names.get(id);
    if (pending === undefined) {
      pending = fetchFile(ctx, id).then(async (file) => {
        if (file.deck_id !== null || file.component_id !== null || file.deleted_at !== null)
          return id;
        const folder = await folderPath(file);
        return folder === '' ? file.filename : `${folder}/${file.filename}`;
      });
      names.set(id, pending);
    }
    return pending;
  };
}

// The image fields of a card's values, with each written reference replaced.
export async function mapImageFields(
  layout: Pick<Layout, 'spec'>,
  fields: CardFields,
  map: (value: string, what: string) => Promise<string>
): Promise<CardFields> {
  const entries = await Promise.all(
    Object.entries(fields).map(async ([key, value]) =>
      layout.spec.fields[key]?.type === 'image' && value.trim() !== ''
        ? [key, await map(value, key)]
        : [key, value]
    )
  );
  return Object.fromEntries(entries) as CardFields;
}

// A card in cards.yaml is named the way its image is, less the extension every
// rendered card has.
export function cardFilename(name: string): string {
  const flat = safeFilename(name);
  return /\.png$/i.test(flat) ? flat : `${flat}.png`;
}

export function cardName(filename: string): string {
  return filename.replace(/\.png$/i, '');
}

function sameFields(a: CardFields, b: CardFields): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? '') === (b[key] ?? ''));
}

// --- Drawing ---------------------------------------------------------------------

// The API draws every laid-out card: saving content draws that card there and
// then, and a change to a layout or to a file cards draw has them drawn again in
// the background. What is left here is asking, and waiting to see what came of
// it.

// A card drawn without saving anything, for iterating on a layout.
export async function previewCard(
  ctx: RuntimeContext,
  projectId: string,
  layout: Pick<Layout, 'width_mm' | 'height_mm' | 'spec'>,
  fields: CardFields
): Promise<Uint8Array> {
  const result = await ctx.api.POST('/api/layouts/preview', {
    body: {
      project_id: projectId,
      width_mm: layout.width_mm,
      height_mm: layout.height_mm,
      spec: layout.spec,
      fields,
    },
    parseAs: 'arrayBuffer',
  });
  if (!result.response.ok) throw toApiError(result.response, result.error);
  return new Uint8Array((result.data as unknown as ArrayBuffer | undefined) ?? new ArrayBuffer(0));
}

type CardOutcome =
  | 'created'
  | 'versioned'
  | 'unchanged'
  | 'pending'
  | 'written'
  | 'would-create'
  | 'would-change'
  | 'failed';

export interface CardResult {
  card: string;
  file_id: string | null;
  outcome: CardOutcome;
  changes?: string[];
  version?: number;
  path?: string;
  error?: string;
}

function describe(result: CardResult): string {
  const changes =
    result.changes !== undefined && result.changes.length > 0
      ? ` (${result.changes.join(', ')})`
      : '';
  switch (result.outcome) {
    case 'created':
      return `Created ${result.card}`;
    case 'versioned':
      return result.version === undefined
        ? `Updated ${result.card}${changes}`
        : `Updated ${result.card} to version ${String(result.version)}${changes}`;
    case 'unchanged':
      return `Unchanged ${result.card}${changes}`;
    case 'pending':
      return `Waiting: ${result.card} -- its image has yet to be drawn again`;
    case 'written':
      return `Wrote ${result.path ?? result.card}`;
    case 'would-create':
      return `Would create ${result.card}`;
    case 'would-change':
      return `Would update ${result.card}${changes}`;
    case 'failed':
      return `${result.card}: ${result.error ?? 'failed'}`;
  }
}

// One card at a time. A card that cannot be drawn or is refused is reported and
// passed over; a refusal that is about the caller stops the run, since every
// later card would meet it too. Each card gets a line as it goes, and what comes
// back is every result with the error the command should end on -- the first
// failure's, or for a check, anything still waiting -- so a caller can print
// JSON first.
export interface CardRun {
  results: CardResult[];
  error: CliError | null;
}

export async function eachCard<T>(
  ctx: RuntimeContext,
  items: readonly T[],
  nameOf: (item: T) => string,
  run: (item: T) => Promise<CardResult>,
  options: { pendingFails?: boolean } = {}
): Promise<CardRun> {
  const results: CardResult[] = [];
  let firstFailure: number | null = null;
  for (const item of items) {
    let result: CardResult;
    try {
      result = await run(item);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      if (status === 401 || status === 403) throw err;
      if (!(err instanceof ApiError || err instanceof CliError)) throw err;
      firstFailure ??= err instanceof ApiError ? exitCodeForStatus(err.status) : err.exitCode;
      result = { card: nameOf(item), file_id: null, outcome: 'failed', error: err.message };
    }
    results.push(result);
    if (ctx.out.json) continue;
    if (result.outcome === 'failed') ctx.out.error(describe(result));
    else ctx.out.line(describe(result));
  }

  const failed = results.filter((r) => r.outcome === 'failed').length;
  const pending = results.filter((r) => r.outcome === 'pending').length;
  let error: CliError | null = null;
  if (firstFailure !== null) {
    error = new CliError(
      `${String(failed)} of ${String(results.length)} cards failed`,
      firstFailure
    );
  } else if (options.pendingFails === true && pending > 0) {
    error = new CliError(
      `${String(pending)} of ${String(results.length)} cards are waiting to be drawn again`,
      EXIT.conflict
    );
  }
  return { results, error };
}

export interface RenderTarget {
  card: DeckCard;
  content: CardContent;
}

// The live cards of a deck that are drawn from a layout, optionally only the
// ones drawn from one layout or named on the command line.
export function storedTargets(
  full: DeckWithCards,
  contents: readonly CardContent[],
  filter: { layoutId?: string; cards?: readonly DeckCard[] } = {}
): RenderTarget[] {
  const byFile = new Map(contents.map((content) => [content.file_id, content]));
  const only =
    filter.cards === undefined ? null : new Set(filter.cards.map((card) => card.file_id));
  return full.cards.flatMap((card) => {
    const content = byFile.get(card.file_id);
    if (content === undefined || !isLiveCard(card)) return [];
    if (filter.layoutId !== undefined && content.layout_id !== filter.layoutId) return [];
    if (only !== null && !only.has(card.file_id)) return [];
    return [{ card, content }];
  });
}

// How long a command waits for the API to finish drawing what it asked for,
// and how often it looks.
const RENDER_WAIT_MS = 10 * 60 * 1000;
const RENDER_POLL_MS = 500;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Waits until none of `targets` is waiting to be drawn, then says what became
// of each: a new image, the same one, or why it could not be drawn. The image a
// target held when it was read is what "new" is measured against.
export async function awaitRenders(
  ctx: RuntimeContext,
  deck: DeckWithCards['deck'],
  targets: readonly RenderTarget[]
): Promise<CardRun> {
  const wanted = new Set(targets.map((target) => target.card.file_id));
  const deadline = Date.now() + RENDER_WAIT_MS;
  let contents = await listCardContent(ctx, deck.id);
  const waiting = () =>
    contents.filter((c) => wanted.has(c.file_id) && c.render_status === 'pending').length;
  while (waiting() > 0 && Date.now() < deadline) {
    await pause(RENDER_POLL_MS);
    contents = await listCardContent(ctx, deck.id);
  }
  const status = new Map(contents.map((content) => [content.file_id, content]));
  const now = new Map((await fetchDeck(ctx, deck.id)).cards.map((card) => [card.file_id, card]));
  return reportRenders(ctx, targets, (target) => ({
    content: status.get(target.card.file_id),
    checksum: now.get(target.card.file_id)?.file.checksum ?? null,
  }));
}

// Where each card stands, without waiting or asking for anything: `--check`.
export function checkRenders(
  ctx: RuntimeContext,
  targets: readonly RenderTarget[]
): Promise<CardRun> {
  return reportRenders(
    ctx,
    targets,
    (target) => ({ content: target.content, checksum: target.card.file.checksum }),
    { pendingFails: true }
  );
}

function reportRenders(
  ctx: RuntimeContext,
  targets: readonly RenderTarget[],
  current: (target: RenderTarget) => { content: CardContent | undefined; checksum: string | null },
  options: { pendingFails?: boolean } = {}
): Promise<CardRun> {
  return eachCard(
    ctx,
    targets,
    (target) => target.card.file.filename,
    async (target) => {
      const { content, checksum } = current(target);
      const base = { card: target.card.file.filename, file_id: target.card.file_id };
      if (content?.render_status === 'failed') {
        throw new CliError(content.render_error ?? 'it could not be drawn', EXIT.invalid);
      }
      if (content?.render_status === 'pending') return { ...base, outcome: 'pending' };
      return {
        ...base,
        outcome: checksum === target.card.file.checksum ? 'unchanged' : 'versioned',
      };
    },
    options
  );
}

// Asks for cards to be drawn again and waits for them.
export async function renderStoredCards(
  ctx: RuntimeContext,
  deck: DeckWithCards['deck'],
  targets: readonly RenderTarget[]
): Promise<CardRun> {
  assertOk(
    await ctx.api.POST('/api/card-content/render', {
      body: { deck_id: deck.id, file_ids: targets.map((target) => target.card.file_id) },
    })
  );
  return awaitRenders(ctx, deck, targets);
}

// Cards drawn from their stored content into a directory, saving nothing.
export async function writeStoredCards(
  ctx: RuntimeContext,
  deck: DeckWithCards['deck'],
  targets: readonly RenderTarget[],
  dir: string
): Promise<CardRun> {
  const layouts = new Map<string, Promise<Layout>>();
  const layoutOf = (id: string) => {
    let pending = layouts.get(id);
    if (pending === undefined) {
      pending = fetchLayout(ctx, id).then((detail) => detail.layout);
      layouts.set(id, pending);
    }
    return pending;
  };
  await mkdir(dir, { recursive: true });
  return eachCard(
    ctx,
    targets,
    (target) => target.card.file.filename,
    async ({ card, content }) => {
      const bytes = await previewCard(
        ctx,
        deck.project_id,
        await layoutOf(content.layout_id),
        content.fields
      );
      const path = join(dir, card.file.filename);
      await writeFile(path, bytes);
      return { card: card.file.filename, file_id: card.file_id, outcome: 'written', path };
    }
  );
}

// --- Pushing a cards file -----------------------------------------------------

export interface PlannedCard {
  name: string;
  filename: string;
  layout: Layout;
  copies: number | null;
  // Image fields already turned into file ids.
  fields: CardFields;
}

// What one push does, card by card: a new card is created from its content, and
// a card whose content changed is saved, which draws it. Either is refused, and
// changes nothing, when the card cannot be drawn.
export async function pushCards(
  ctx: RuntimeContext,
  full: DeckWithCards,
  planned: readonly PlannedCard[],
  options: { dryRun: boolean }
): Promise<CardRun> {
  const contents = new Map(
    (await listCardContent(ctx, full.deck.id)).map((content) => [content.file_id, content])
  );
  const live = new Map(
    full.cards.filter(isLiveCard).map((card) => [card.file.filename.toLowerCase(), card])
  );
  const copies = new Map<string, number>();

  const run = await eachCard(
    ctx,
    planned,
    (entry) => entry.filename,
    async (entry): Promise<CardResult> => {
      const existing = live.get(entry.filename.toLowerCase());

      if (existing === undefined) {
        if (options.dryRun) return { card: entry.filename, file_id: null, outcome: 'would-create' };
        const created = assertOk(
          await ctx.api.POST('/api/card-content', {
            body: {
              id: randomUUID(),
              deck_id: full.deck.id,
              filename: entry.filename,
              layout_id: entry.layout.id,
              fields: entry.fields,
            },
          })
        );
        if (entry.copies !== null) copies.set(created.file.id, entry.copies);
        return { card: created.file.filename, file_id: created.file.id, outcome: 'created' };
      }

      const before = contents.get(existing.file_id);
      const changes: string[] = [];
      const contentChanged =
        before === undefined ||
        before.layout_id !== entry.layout.id ||
        !sameFields(before.fields, entry.fields);
      if (contentChanged)
        changes.push(before === undefined ? 'now drawn from a layout' : 'content');
      if (entry.copies !== null && entry.copies !== existing.quantity) {
        changes.push(`${String(existing.quantity)} → ${String(entry.copies)} copies`);
        copies.set(existing.file_id, entry.copies);
      }
      const base = { card: existing.file.filename, file_id: existing.file_id, changes };

      if (options.dryRun)
        return { ...base, outcome: changes.length > 0 ? 'would-change' : 'unchanged' };
      if (!contentChanged) return { ...base, outcome: 'unchanged' };
      const saved = assertOk(
        await ctx.api.PUT('/api/card-content/{fileId}', {
          params: { path: { fileId: existing.file_id } },
          body: { layout_id: entry.layout.id, fields: entry.fields },
        })
      );
      return saved.image_version === null
        ? { ...base, outcome: 'unchanged' }
        : { ...base, outcome: 'versioned', version: saved.image_version };
    }
  );
  // Written even when some cards failed: the ones that went up should not be
  // left at the count an upload gives them.
  if (!options.dryRun) await saveCopies(ctx, full.deck.id, copies);
  return run;
}

// One save of the whole arrangement, read fresh so the cards created by this
// push are in it. The read is every row, deleted cards included, so sending it
// back changes nothing but the counts.
async function saveCopies(
  ctx: RuntimeContext,
  deckId: string,
  copies: ReadonlyMap<string, number>
): Promise<void> {
  if (copies.size === 0) return;
  const latest = assertOk(
    await ctx.api.GET('/api/decks/{deckId}', { params: { path: { deckId } } })
  );
  const next = latest.cards.map((card) =>
    copies.has(card.file_id) ? { ...card, quantity: copies.get(card.file_id)! } : card
  );
  assertOk(
    await ctx.api.PUT('/api/decks/{deckId}/cards', {
      params: { path: { deckId } },
      body: { cards: cardsInput(next) },
    })
  );
}
