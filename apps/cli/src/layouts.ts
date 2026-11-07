import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLiveCard, type CardFields } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { ApiError, CliError, EXIT, assertOk, exitCodeForStatus } from './errors.ts';
import { readAllStdin } from './prompt.ts';
import {
  fetchDirectory,
  fetchFile,
  folderPathOf,
  matchRef,
  resolveFileRef,
  type DeckCard,
  type DeckWithCards,
  type Project,
} from './resolve.ts';
import { appendVersion, downloadBytes, sendFile } from './transfer.ts';
import { cardsInput, safeFilename } from './decks.ts';
import { CardRenderer } from './layout/render.ts';
import { CardRenderError, type CardLayout } from './layout/svg.ts';
import type { RuntimeContext } from './context.ts';

type Schemas = components['schemas'];
export type Layout = Schemas['CardLayout'];
export type LayoutWithDecks = Schemas['CardLayoutWithDecks'];
export type CardContent = Schemas['CardContent'];
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

// --- Rendering -------------------------------------------------------------------

export function newRenderer(ctx: RuntimeContext): CardRenderer {
  return new CardRenderer((id) => downloadBytes(ctx, id));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sizeOf(width: number, height: number): string {
  return `${String(width)} × ${String(height)} mm`;
}

// Refused before anything is drawn: a layout on a card of another size would
// render without complaint and print at the wrong scale.
export function assertLayoutFits(layout: Layout | CardLayout, deck: DeckWithCards['deck']): void {
  if (layout.width_mm !== deck.card_width_mm || layout.height_mm !== deck.card_height_mm) {
    throw new CardRenderError(
      `${layout.name} is drawn on a ${sizeOf(layout.width_mm, layout.height_mm)} card and ${deck.name}'s cards are ${sizeOf(deck.card_width_mm, deck.card_height_mm)}`
    );
  }
}

type CardOutcome =
  | 'created'
  | 'versioned'
  | 'unchanged'
  | 'stale'
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
      return `Updated ${result.card} to version ${String(result.version)}${changes}`;
    case 'unchanged':
      return `Unchanged ${result.card}${changes}`;
    case 'stale':
      return `Out of date: ${result.card} -- its image is not what its content renders to`;
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

// One card at a time, the way uploads go: the quota is checked per request. A
// card that cannot be drawn or is refused is reported and passed over; a
// refusal that is about the caller stops the run, since every later card would
// meet it too. Each card gets a line as it goes, and what comes back is every
// result with the error the command should end on -- the first failure's, or
// for a check, anything out of date -- so a caller can print JSON first.
export interface CardRun {
  results: CardResult[];
  error: CliError | null;
}

export async function eachCard<T>(
  ctx: RuntimeContext,
  items: readonly T[],
  nameOf: (item: T) => string,
  run: (item: T) => Promise<CardResult>,
  options: { staleFails?: boolean } = {}
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
      if (!(err instanceof ApiError || err instanceof CliError || err instanceof CardRenderError)) {
        throw err;
      }
      firstFailure ??=
        err instanceof ApiError
          ? exitCodeForStatus(err.status)
          : err instanceof CliError
            ? err.exitCode
            : EXIT.invalid;
      result = { card: nameOf(item), file_id: null, outcome: 'failed', error: err.message };
    }
    results.push(result);
    if (ctx.out.json) continue;
    if (result.outcome === 'failed') ctx.out.error(describe(result));
    else ctx.out.line(describe(result));
  }

  const failed = results.filter((r) => r.outcome === 'failed').length;
  const stale = results.filter((r) => r.outcome === 'stale').length;
  let error: CliError | null = null;
  if (firstFailure !== null) {
    error = new CliError(
      `${String(failed)} of ${String(results.length)} cards failed`,
      firstFailure
    );
  } else if (options.staleFails === true && stale > 0) {
    error = new CliError(
      `${String(stale)} of ${String(results.length)} cards are out of date; threepeaks deck render updates them`,
      EXIT.conflict
    );
  }
  return { results, error };
}

export type RenderMode = { kind: 'push' } | { kind: 'check' } | { kind: 'write'; dir: string };

export interface RenderTarget {
  card: DeckCard;
  content: CardContent;
}

// Re-renders cards from the content already stored, after a layout or one of
// its files changed. Only a card whose bytes would differ gets a version.
export async function renderStoredCards(
  ctx: RuntimeContext,
  deck: DeckWithCards['deck'],
  targets: readonly RenderTarget[],
  mode: RenderMode
): Promise<CardRun> {
  const renderer = newRenderer(ctx);
  const layouts = new Map<string, Promise<Layout>>();
  const layoutOf = (id: string) => {
    let pending = layouts.get(id);
    if (pending === undefined) {
      pending = fetchLayout(ctx, id).then((detail) => detail.layout);
      layouts.set(id, pending);
    }
    return pending;
  };
  if (mode.kind === 'write') await mkdir(mode.dir, { recursive: true });

  return eachCard(
    ctx,
    targets,
    (target) => target.card.file.filename,
    async ({ card, content }) => {
      const layout = await layoutOf(content.layout_id);
      assertLayoutFits(layout, deck);
      const bytes = await renderer.render(layout, content.fields);
      const base = { card: card.file.filename, file_id: card.file_id };
      if (mode.kind === 'write') {
        const path = join(mode.dir, card.file.filename);
        await writeFile(path, bytes);
        return { ...base, outcome: 'written', path };
      }
      if (sha256(bytes) === card.file.checksum) return { ...base, outcome: 'unchanged' };
      if (mode.kind === 'check') return { ...base, outcome: 'stale' };
      const uploaded = await appendVersion(ctx, card.file, bytes);
      return uploaded.outcome === 'versioned'
        ? { ...base, outcome: 'versioned', version: uploaded.version?.version_number }
        : { ...base, outcome: 'unchanged' };
    },
    { staleFails: mode.kind === 'check' }
  );
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

// --- Pushing a cards file -----------------------------------------------------

export interface PlannedCard {
  name: string;
  filename: string;
  layout: Layout;
  copies: number | null;
  // Image fields already turned into file ids.
  fields: CardFields;
}

// What one push does, card by card: render first, so a card that cannot be
// drawn changes nothing at all; then the content, then the image, in that
// order for a card that exists -- truth before the picture of it, so a failed
// upload leaves a card the next render repairs -- and the image first for a
// new one, which has no file to hang content on until it is uploaded.
export async function pushCards(
  ctx: RuntimeContext,
  project: Project,
  full: DeckWithCards,
  planned: readonly PlannedCard[],
  options: { dryRun: boolean }
): Promise<CardRun> {
  const renderer = newRenderer(ctx);
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
      assertLayoutFits(entry.layout, full.deck);
      const bytes = await renderer.render(entry.layout, entry.fields);
      const existing = live.get(entry.filename.toLowerCase());

      if (existing === undefined) {
        if (options.dryRun) return { card: entry.filename, file_id: null, outcome: 'would-create' };
        const { body } = await sendFile<FileRow>(
          ctx,
          '/api/files/upload',
          {
            id: randomUUID(),
            project_id: project.id,
            deck_id: full.deck.id,
            filename: entry.filename,
          },
          bytes
        );
        await putContent(ctx, body.id, entry);
        if (entry.copies !== null) copies.set(body.id, entry.copies);
        return { card: body.filename, file_id: body.id, outcome: 'created' };
      }

      const before = contents.get(existing.file_id);
      const changes: string[] = [];
      const contentChanged =
        before === undefined ||
        before.layout_id !== entry.layout.id ||
        !sameFields(before.fields, entry.fields);
      if (contentChanged)
        changes.push(before === undefined ? 'now drawn from a layout' : 'content');
      const imageChanged = sha256(bytes) !== existing.file.checksum;
      if (imageChanged) changes.push('image');
      if (entry.copies !== null && entry.copies !== existing.quantity) {
        changes.push(`${String(existing.quantity)} → ${String(entry.copies)} copies`);
        copies.set(existing.file_id, entry.copies);
      }
      const base = { card: existing.file.filename, file_id: existing.file_id, changes };

      if (options.dryRun)
        return { ...base, outcome: changes.length > 0 ? 'would-change' : 'unchanged' };
      if (contentChanged) await putContent(ctx, existing.file_id, entry);
      if (!imageChanged) return { ...base, outcome: 'unchanged' };
      const uploaded = await appendVersion(ctx, existing.file, bytes);
      return { ...base, outcome: 'versioned', version: uploaded.version?.version_number };
    }
  );
  // Written even when some cards failed: the ones that went up should not be
  // left at the count an upload gives them.
  if (!options.dryRun) await saveCopies(ctx, full.deck.id, copies);
  return run;
}

async function putContent(ctx: RuntimeContext, fileId: string, entry: PlannedCard): Promise<void> {
  assertOk(
    await ctx.api.PUT('/api/card-content/{fileId}', {
      params: { path: { fileId } },
      body: { layout_id: entry.layout.id, fields: entry.fields },
    })
  );
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
