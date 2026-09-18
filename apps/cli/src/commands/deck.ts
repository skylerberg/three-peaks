import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import {
  CARD_PRESETS,
  DEFAULT_CARD_PRESET_ID,
  formatBytes,
  isLiveCard,
  withHiddenCards,
} from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { collect, group, inProject, leaf, optList, optString, withCtx, type Opts } from '../kit.ts';
import { CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { minute, shortId } from '../output.ts';
import {
  UUID_RE,
  fetchDeck,
  fetchFile,
  listDecks,
  listDeleted,
  matchCard,
  matchRef,
  projectFromOpts,
  resolveDeck,
  type Deck,
  type DeckCard,
  type DeckWithCards,
  type FileRow,
  type Project,
} from '../resolve.ts';
import {
  appendVersion,
  assertAbsent,
  fetchFileBytes,
  sendFile,
  uploadEach,
  type UploadResult,
} from '../transfer.ts';
import { applyAssignments, formatSettings, mergeSettings, readSettingsFile } from '../settings.ts';
import {
  cardsInput,
  defaultCardModel,
  parseQuantity,
  presetSize,
  safeFilename,
  shownCards,
  sizeFromOptions,
  sizeLabel,
} from '../decks.ts';
import { placementFromOpts, reorder, sameOrder } from '../placement.ts';
import { purgeDeleted, restoreDeleted } from '../tombstones.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type Schemas = components['schemas'];
type ImportRun = Schemas['ImportRun'];
type DeckImport = Schemas['DeckImport'];
type ModelSettings = Schemas['ComponentModel']['settings'];

interface LoadedDeck {
  project: Project;
  deck: Deck;
  full: DeckWithCards;
}

async function loadDeck(ctx: RuntimeContext, opts: Opts, ref: string): Promise<LoadedDeck> {
  const project = await projectFromOpts(ctx, opts);
  const deck = await resolveDeck(ctx, project.id, ref);
  return { project, deck, full: await fetchDeck(ctx, deck.id) };
}

async function saveCards(
  ctx: RuntimeContext,
  deckId: string,
  list: readonly DeckCard[]
): Promise<DeckWithCards> {
  return assertOk(
    await ctx.api.PUT('/api/decks/{deckId}/cards', {
      params: { path: { deckId } },
      body: { cards: cardsInput(list) },
    })
  );
}

function copiesLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'copy' : 'copies'}`;
}

function totalsLine(full: DeckWithCards): string {
  return `${String(full.deck.card_count)} ${full.deck.card_count === 1 ? 'card' : 'cards'} · ${String(full.deck.total_copies)} to print`;
}

// The back is named by id alone and need not be a card, so it may have to be
// read on its own to be named at all.
async function backFile(ctx: RuntimeContext, full: DeckWithCards): Promise<FileRow | null> {
  const id = full.deck.back_file_id;
  if (id === null) return null;
  return full.cards.find((card) => card.file_id === id)?.file ?? (await fetchFile(ctx, id));
}

function printDeckSummary(ctx: RuntimeContext, deck: Deck): void {
  ctx.out.line(`${deck.name} (${shortId(deck.id)}) — ${sizeLabel(deck)}`);
}

function registerArrangement(deckCmd: Command, deps: CliDeps): void {
  deckCmd.addCommand(
    inProject(leaf('copies'))
      .description('Set how many copies of a card the deck prints (0 keeps the card, prints none)')
      .argument('<deck>', 'deck id or name')
      .argument('<card>', 'card file id or filename')
      .argument('<count>', 'number of copies')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, cardRef, count) => {
          const quantity = parseQuantity(count);
          const { full } = await loadDeck(ctx, opts, deckRef);
          const card = matchCard(full, cardRef);
          if (card.quantity === quantity) {
            ctx.out.data(full, () =>
              ctx.out.line(`${card.file.filename} already has ${copiesLabel(quantity)}`)
            );
            return;
          }
          // Every row the deck holds goes back, deleted ones included, because
          // the save replaces the whole arrangement.
          const saved = await saveCards(
            ctx,
            full.deck.id,
            full.cards.map((row) => (row.file_id === card.file_id ? { ...row, quantity } : row))
          );
          ctx.out.data(saved, () =>
            ctx.out.line(
              `${card.file.filename}: ${copiesLabel(quantity)} (${saved.deck.name} is now ${totalsLine(saved)})`
            )
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('move-card'))
      .description("Move a card within the deck's print order")
      .argument('<deck>', 'deck id or name')
      .argument('<card>', 'card file id or filename')
      .option('--top', 'first in the deck')
      .option('--bottom', 'last in the deck')
      .option('--before <card>', 'directly before this card')
      .option('--after <card>', 'directly after this card')
      .option('--position <n>', 'at this position, counted from 1 as `deck show` numbers them')
      .option('--all', 'count cards whose image is deleted too, as `deck show --all` does')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, cardRef) => {
          const { full } = await loadDeck(ctx, opts, deckRef);
          const all = opts.all === true;
          const drawn = shownCards(full.cards, all);
          const inDrawn = (ref: string): DeckCard => {
            const card = matchCard(full, ref);
            if (!drawn.some((row) => row.file_id === card.file_id)) {
              throw new CliError(
                `${card.file.filename}'s image is deleted, so it is not in the print order; pass --all to arrange deleted cards too`,
                EXIT.usage
              );
            }
            return card;
          };
          const card = inDrawn(cardRef);
          const placement = placementFromOpts(opts);
          const anchor =
            placement.kind === 'before' || placement.kind === 'after'
              ? inDrawn(placement.ref).file_id
              : undefined;
          const before = drawn.map((row) => row.file_id);
          const after = reorder(before, card.file_id, placement, anchor);
          const byId = new Map(drawn.map((row) => [row.file_id, row]));
          const next = after.map((id) => byId.get(id)!);
          const where = `position ${String(after.indexOf(card.file_id) + 1)} of ${String(after.length)}`;
          // Put back where it was is not a move: saving would renumber the deck
          // and announce an edit to every open screen for nothing.
          if (sameOrder(before, after)) {
            ctx.out.data(full, () => ctx.out.line(`${card.file.filename} is already at ${where}`));
            return;
          }
          const saved = await saveCards(ctx, full.deck.id, withHiddenCards(full.cards, next));
          ctx.out.data(saved, () => ctx.out.line(`Moved ${card.file.filename} to ${where}`));
        })
      )
  );
}

// The deck's live files by lowercased name, which is how the server keeps a
// name unique within one deck: the cards, and the back when it is not one.
async function liveFilesByName(
  ctx: RuntimeContext,
  full: DeckWithCards
): Promise<Map<string, FileRow>> {
  const files = full.cards.filter(isLiveCard).map((card) => card.file);
  const back = await backFile(ctx, full);
  if (back !== null && back.deleted_at === null) files.push(back);
  return new Map(files.map((file) => [file.filename.toLowerCase(), file]));
}

async function uploadOne(
  ctx: RuntimeContext,
  project: Project,
  full: DeckWithCards,
  existing: Map<string, FileRow>,
  path: string,
  opts: { back: boolean; replace: boolean }
): Promise<UploadResult> {
  const filename = basename(path);
  const same = existing.get(filename.toLowerCase());
  let result: UploadResult;
  if (opts.replace && same !== undefined) {
    result = await appendVersion(ctx, same, path);
  } else {
    const { body } = await sendFile<FileRow>(
      ctx,
      '/api/files/upload',
      { id: randomUUID(), project_id: project.id, deck_id: full.deck.id, filename },
      path
    );
    existing.set(body.filename.toLowerCase(), body);
    result = { path, outcome: 'uploaded', file: body, file_id: body.id, filename: body.filename };
    // Uploaded as a card and then made the back, rather than in the upload's
    // own back role: that role gives the image no place in the card list, so
    // once another back replaced it nothing could choose it again and every
    // later save of the deck would refuse it as artwork with no place. Held at
    // no copies, the way an imported back is, so it does not print as a front.
    if (opts.back) {
      const latest = await fetchDeck(ctx, full.deck.id);
      await saveCards(
        ctx,
        full.deck.id,
        latest.cards.map((row) => (row.file_id === body.id ? { ...row, quantity: 0 } : row))
      );
    }
  }
  const chosen = result.file_id ?? null;
  if (opts.back && chosen !== null && full.deck.back_file_id !== chosen) {
    assertOk(
      await ctx.api.PATCH('/api/decks/{deckId}', {
        params: { path: { deckId: full.deck.id } },
        body: { back_file_id: chosen },
      })
    );
  }
  return result;
}

function registerTransfer(deckCmd: Command, deps: CliDeps): void {
  deckCmd.addCommand(
    inProject(leaf('upload'))
      .description('Upload images into a deck: each becomes a card, or with --back the back')
      .argument('<deck>', 'deck id or name')
      .argument('<paths...>', 'image files to upload')
      .option('--back', "make the (single) image the deck's back rather than a card")
      .option('--replace', 'a file of the same name in the deck gets the image as a new version')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, pathsArg) => {
          const paths = pathsArg as unknown as string[];
          const back = opts.back === true;
          const replace = opts.replace === true;
          if (back && paths.length !== 1) {
            throw new CliError('A deck has one back; pass a single image with --back', EXIT.usage);
          }
          const { project, full } = await loadDeck(ctx, opts, deckRef);
          const existing = await liveFilesByName(ctx, full);
          const where = back ? `${full.deck.name} as its back` : full.deck.name;
          await uploadEach(ctx, paths, where, (path) =>
            uploadOne(ctx, project, full, existing, path, { back, replace })
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('download'))
      .description('Download every live card, and the back, into a directory')
      .argument('<deck>', 'deck id or name')
      .option('-o, --output <dir>', 'directory to write into (default: one named after the deck)')
      .option('--force', 'overwrite files that already exist there')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const { full } = await loadDeck(ctx, opts, deckRef);
          const dir = optString(opts, 'output') ?? safeFilename(full.deck.name);
          const files = [...(await liveFilesByName(ctx, full)).values()];
          if (files.length === 0) {
            ctx.out.data({ directory: dir, files: [] }, () =>
              ctx.out.line(`${full.deck.name} has no images to download`)
            );
            return;
          }
          const targets = files.map((file) => ({
            file,
            path: join(dir, safeFilename(file.filename)),
          }));
          // Every target is checked before any byte is written, so a clash
          // refuses the whole download rather than leaving half of it behind.
          if (opts.force !== true) {
            for (const target of targets) await assertAbsent(target.path);
          }
          await mkdir(dir, { recursive: true });
          const written: { file_id: string; path: string; bytes: number }[] = [];
          for (const target of targets) {
            const bytes = await fetchFileBytes(ctx, target.file.id, undefined, target.path);
            written.push({ file_id: target.file.id, path: target.path, bytes });
          }
          const total = written.reduce((sum, entry) => sum + entry.bytes, 0);
          ctx.out.data({ directory: dir, files: written }, () =>
            ctx.out.line(
              `Wrote ${String(written.length)} ${written.length === 1 ? 'file' : 'files'} (${formatBytes(total)}) to ${dir}`
            )
          );
        })
      )
  );
}

export function registerDeck(program: Command, deps: CliDeps): void {
  const deckCmd = group('deck', 'Decks: their cards, copies, back, 3D settings and import history');

  deckCmd.addCommand(
    inProject(leaf('list'))
      .description('List the decks in a project')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const project = await projectFromOpts(ctx, opts);
          const decks = await listDecks(ctx, project.id);
          ctx.out.data(decks, () => {
            if (decks.length === 0) {
              ctx.out.line(`No decks in "${project.name}"`);
              return;
            }
            ctx.out.table(
              ['ID', 'NAME', 'SIZE', 'CARDS', 'TO PRINT'],
              decks.map((deck) => [
                shortId(deck.id),
                deck.name,
                sizeLabel(deck),
                String(deck.card_count),
                String(deck.total_copies),
              ])
            );
          });
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('show'))
      .description('Show a deck and its cards in print order')
      .argument('<deck>', 'deck id or name')
      .option('--all', 'include cards whose image is deleted (they print nothing)')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const { full } = await loadDeck(ctx, opts, deckRef);
          const back = await backFile(ctx, full);
          ctx.out.data(full, () => {
            const all = opts.all === true;
            const drawn = shownCards(full.cards, all);
            const hidden = full.cards.length - full.cards.filter(isLiveCard).length;
            printDeckSummary(ctx, full.deck);
            ctx.out.line(
              totalsLine(full) +
                (hidden > 0 && !all
                  ? ` · ${String(hidden)} deleted ${hidden === 1 ? 'card' : 'cards'} hidden (--all shows ${hidden === 1 ? 'it' : 'them'})`
                  : '')
            );
            ctx.out.line(
              back === null
                ? 'Back: none — sheets for this deck print fronts only'
                : `Back: ${back.filename} (${shortId(back.id)})${back.deleted_at === null ? '' : ' — deleted'}`
            );
            if (drawn.length === 0) {
              ctx.out.line('No cards yet. Add some with: threepeaks deck upload <deck> <paths...>');
              return;
            }
            ctx.out.line();
            ctx.out.table(
              ['#', 'COPIES', 'CARD', 'ID', 'NOTE'],
              drawn.map((card, index) => [
                String(index + 1),
                String(card.quantity),
                card.file.filename,
                shortId(card.file_id),
                [
                  card.file_id === full.deck.back_file_id ? "the deck's back" : '',
                  isLiveCard(card) ? '' : 'deleted',
                ]
                  .filter((note) => note !== '')
                  .join(', '),
              ])
            );
          });
        })
      )
  );

  deckCmd.addCommand(
    leaf('sizes')
      .description('List the named card sizes a deck can be given')
      .action(
        withCtx(deps, async (ctx) => {
          ctx.out.data(CARD_PRESETS, () =>
            ctx.out.table(
              ['ID', 'NAME', 'WIDTH', 'HEIGHT'],
              CARD_PRESETS.map((preset) => [
                preset.id + (preset.id === DEFAULT_CARD_PRESET_ID ? ' (default)' : ''),
                preset.name,
                `${String(preset.width_mm)} mm`,
                `${String(preset.height_mm)} mm`,
              ])
            )
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('create'))
      .description('Create an empty deck')
      .argument('<name>', 'deck name, unique in the project')
      .option(
        '--size <size>',
        `a named card size from \`deck sizes\` (default ${DEFAULT_CARD_PRESET_ID})`
      )
      .option('--width <mm>', 'card width in millimetres (with --height)')
      .option('--height <mm>', 'card height in millimetres (with --width)')
      .action(
        withCtx(deps, async (ctx, opts, name) => {
          const given = sizeFromOptions({
            size: optString(opts, 'size'),
            width: optString(opts, 'width'),
            height: optString(opts, 'height'),
          });
          const size = given ?? presetSize(DEFAULT_CARD_PRESET_ID);
          if (size.width_mm === undefined || size.height_mm === undefined) {
            throw new CliError('A new deck needs both --width and --height', EXIT.usage);
          }
          const project = await projectFromOpts(ctx, opts);
          const created = assertOk(
            await ctx.api.POST('/api/decks', {
              body: {
                id: randomUUID(),
                project_id: project.id,
                name,
                card_width_mm: size.width_mm,
                card_height_mm: size.height_mm,
              },
            })
          );
          ctx.out.data(created, () =>
            ctx.out.line(
              `Created deck ${created.name} (${shortId(created.id)}) — ${sizeLabel(created)}`
            )
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('update'))
      .description('Rename a deck or change its card size')
      .argument('<deck>', 'deck id or name')
      .option('--name <name>', 'new name')
      .option('--size <size>', 'a named card size from `deck sizes`')
      .option('--width <mm>', 'card width in millimetres')
      .option('--height <mm>', 'card height in millimetres')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const name = optString(opts, 'name');
          const size = sizeFromOptions({
            size: optString(opts, 'size'),
            width: optString(opts, 'width'),
            height: optString(opts, 'height'),
          });
          if (name === undefined && size === undefined) {
            throw new CliError('Pass --name, --size, --width or --height', EXIT.usage);
          }
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const updated = assertOk(
            await ctx.api.PATCH('/api/decks/{deckId}', {
              params: { path: { deckId: deck.id } },
              body: {
                ...(name === undefined ? {} : { name }),
                ...(size?.width_mm === undefined ? {} : { card_width_mm: size.width_mm }),
                ...(size?.height_mm === undefined ? {} : { card_height_mm: size.height_mm }),
              },
            })
          );
          ctx.out.data(updated, () =>
            ctx.out.line(`Updated ${updated.name} — ${sizeLabel(updated)}`)
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('back'))
      .description("Choose which of the deck's images prints on the reverse of every card")
      .argument('<deck>', 'deck id or name')
      .argument('[card]', 'card file id or filename')
      .option('--none', 'no back: sheets for this deck print fronts only')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, cardRef) => {
          const none = opts.none === true;
          if (none === (cardRef !== undefined)) {
            throw new CliError('Name the card to use as the back, or pass --none', EXIT.usage);
          }
          const { full } = await loadDeck(ctx, opts, deckRef);
          const card = none ? null : matchCard(full, cardRef);
          const updated = assertOk(
            await ctx.api.PATCH('/api/decks/{deckId}', {
              params: { path: { deckId: full.deck.id } },
              body: { back_file_id: card === null ? null : card.file_id },
            })
          );
          ctx.out.data(updated, () =>
            ctx.out.line(
              card === null
                ? `${updated.name} has no back; its sheets print fronts only`
                : `The back of ${updated.name} is now ${card.file.filename}`
            )
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('delete'))
      .description('Delete a deck; it can be restored unless --purge is given')
      .argument('<deck>', 'deck id or name (with --purge, a deleted deck too)')
      .option('--purge', 'delete it permanently, with every card image in it')
      .option('--force', 'skip the confirmation --purge asks for')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const purge = opts.purge === true;
          const target = purge
            ? await deckForPurge(ctx, project.id, deckRef)
            : await resolveDeck(ctx, project.id, deckRef);
          if (purge) {
            await confirmOrAbort(
              ctx,
              `Permanently delete ${target.name} and every card image in it? This cannot be undone.`,
              opts.force === true
            );
          }
          if (purge) {
            await purgeDeleted(ctx, { kind: 'deck', id: target.id });
          } else {
            assertDone(
              await ctx.api.DELETE('/api/decks/{deckId}', {
                params: { path: { deckId: target.id } },
              })
            );
          }
          ctx.out.data({ deleted: target.id, purged: purge }, () =>
            ctx.out.line(
              purge
                ? `Permanently deleted ${target.name}`
                : `Deleted ${target.name}. Restore it with: threepeaks deck restore "${target.name}"`
            )
          );
        })
      )
  );

  deckCmd.addCommand(
    inProject(leaf('restore'))
      .description('Restore a deleted deck, with whatever cards it still has')
      .argument('<deck>', 'deleted deck id or name')
      .option('--name <name>', 'restore it under a new name, when its own has been taken meanwhile')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const entry = matchRef(
            deckRef,
            (await listDeleted(ctx, project.id)).filter((e) => e.kind === 'deck'),
            'deleted deck',
            (e) => e.id,
            (e) => e.name
          );
          const restored = (await restoreDeleted(
            ctx,
            entry,
            optString(opts, 'name')
          )) as DeckWithCards;
          ctx.out.data(restored, () =>
            ctx.out.line(`Restored ${restored.deck.name} — ${totalsLine(restored)}`)
          );
        })
      )
  );

  registerTransfer(deckCmd, deps);
  registerArrangement(deckCmd, deps);
  registerModel(deckCmd, deps);
  registerImport(deckCmd, deps);
  program.addCommand(deckCmd);
}

// A purge may name a deck already in Deleted, which the live listing no longer
// has: purging is how a tombstone is finally let go of.
async function deckForPurge(
  ctx: RuntimeContext,
  projectId: string,
  ref: string
): Promise<{ id: string; name: string }> {
  try {
    return await resolveDeck(ctx, projectId, ref);
  } catch (err) {
    if (!(err instanceof CliError) || err.exitCode !== EXIT.notFound) throw err;
  }
  return matchRef(
    ref,
    (await listDeleted(ctx, projectId)).filter((e) => e.kind === 'deck'),
    'deck',
    (e) => e.id,
    (e) => e.name
  );
}

interface ModelView {
  file_id: string;
  // False for an image nobody has dialled in, whose settings are the defaults a
  // save would start from rather than anything stored.
  saved: boolean;
  updated_at: string | null;
  settings: ModelSettings;
}

async function readModel(ctx: RuntimeContext, deck: Deck, fileId: string): Promise<ModelView> {
  const result = await ctx.api.GET('/api/models/{fileId}', { params: { path: { fileId } } });
  if (result.response.status === 404) {
    return { file_id: fileId, saved: false, updated_at: null, settings: defaultCardModel(deck) };
  }
  const stored = assertOk(result);
  return { file_id: fileId, saved: true, updated_at: stored.updated_at, settings: stored.settings };
}

// `back_file_id` is an id on the wire, but the card it names is one of this
// deck's, so the name `deck show` prints is accepted and resolved here.
function resolveBackAssignment(full: DeckWithCards, assignment: string): string {
  const eq = assignment.indexOf('=');
  if (eq <= 0 || assignment.slice(0, eq).trim() !== 'back_file_id') return assignment;
  const value = assignment.slice(eq + 1).trim();
  if (value === '' || value === 'null' || UUID_RE.test(value)) return assignment;
  return `back_file_id=${matchCard(full, value).file_id}`;
}

function modelLines(view: ModelView, full: DeckWithCards): string[] {
  const back = 'back_file_id' in view.settings ? view.settings.back_file_id : null;
  const backName =
    back === null ? null : full.cards.find((card) => card.file_id === back)?.file.filename;
  return formatSettings(view.settings).map((line) =>
    line.startsWith('back_file_id = ') && backName != null ? `${line} (${backName})` : line
  );
}

function registerModel(deckCmd: Command, deps: CliDeps): void {
  deckCmd.addCommand(
    inProject(leaf('model'))
      .description("Show or change a card's 3D settings (the studio's dial-in)")
      .argument('<deck>', 'deck id or name')
      .argument('<card>', 'card file id or filename')
      .option('--set <key=value>', 'change one setting; repeatable', collect, [])
      .option('--file <path>', 'lay a JSON object of settings over the current ones (- for stdin)')
      .option('--reset', "start from the defaults, sized to the deck's cards")
      .action(
        withCtx(deps, async (ctx, opts, deckRef, cardRef) => {
          const { deck, full } = await loadDeck(ctx, opts, deckRef);
          const card = matchCard(full, cardRef);
          const current = await readModel(ctx, deck, card.file_id);
          const assignments = optList(opts, 'set').map((a) => resolveBackAssignment(full, a));
          const file = optString(opts, 'file');
          const reset = opts.reset === true;

          if (assignments.length === 0 && file === undefined && !reset) {
            ctx.out.data(current, () => {
              ctx.out.line(
                `${card.file.filename} — ${current.saved ? `3D settings, saved ${minute(current.updated_at)}` : '3D settings: never dialled in, these are the defaults'}`
              );
              for (const line of modelLines(current, full)) ctx.out.line(`  ${line}`);
            });
            return;
          }

          let next: { kind: string } = reset ? defaultCardModel(deck) : current.settings;
          if (file !== undefined) next = mergeSettings(next, await readSettingsFile(ctx, file));
          next = applyAssignments(next, assignments);

          const saved = assertOk(
            await ctx.api.PUT('/api/models/{fileId}', {
              params: { path: { fileId: card.file_id } },
              body: { settings: next as unknown as ModelSettings },
            })
          );
          const view: ModelView = {
            file_id: card.file_id,
            saved: true,
            updated_at: saved.updated_at,
            settings: saved.settings,
          };
          ctx.out.data(view, () => {
            ctx.out.line(`Saved 3D settings for ${card.file.filename}`);
            for (const line of modelLines(view, full)) ctx.out.line(`  ${line}`);
          });
        })
      )
  );
}

async function readImport(ctx: RuntimeContext, deckId: string): Promise<DeckImport | null> {
  const result = await ctx.api.GET('/api/decks/{deckId}/import', {
    params: { path: { deckId } },
  });
  // 404 is a deck nothing has been imported into, which is not a state
  // anybody has to fix.
  if (result.response.status === 404) return null;
  return assertOk(result);
}

async function listRuns(ctx: RuntimeContext, deckId: string): Promise<ImportRun[]> {
  return assertOk(
    await ctx.api.GET('/api/decks/{deckId}/import/runs', { params: { path: { deckId } } })
  ).runs;
}

// Runs have no name, so a reference is an id, an id prefix, or `latest` for
// the newest -- which is what somebody reaching for the history usually wants.
function matchRun(ref: string, runs: readonly ImportRun[]): ImportRun {
  if (ref.toLowerCase() === 'latest') {
    const newest = runs[0];
    if (newest === undefined)
      throw new CliError('Nothing has been imported into this deck', EXIT.notFound);
    return newest;
  }
  return matchRef(
    ref,
    runs,
    'import run',
    (run) => run.id,
    () => ''
  );
}

function countsLine(run: ImportRun): string {
  const c = run.counts;
  const parts = [
    `${String(c.added)} added`,
    `${String(c.updated)} updated`,
    `${String(c.unchanged)} unchanged`,
    `${String(c.removed)} removed`,
  ];
  if (c.restored > 0) parts.push(`${String(c.restored)} restored`);
  return parts.join(', ');
}

function runHeading(run: ImportRun): string {
  const when =
    run.finished_at === null
      ? `started ${minute(run.started_at)}`
      : `${minute(run.started_at)} – ${minute(run.finished_at)}`;
  const source = run.source_label === null ? '' : ` from ${run.source_label}`;
  return `Import ${shortId(run.id)} — ${run.status}, ${when}${source}`;
}

const OUTCOME_ORDER = ['removed', 'added', 'updated', 'unchanged'];

function matchLabel(matchedBy: string | null): string {
  switch (matchedBy) {
    case 'page_id':
      return 'Canva page';
    case 'identity':
      return 'page name';
    case 'page_number':
      return 'page number';
    default:
      return 'new card';
  }
}

// Dated rather than flagged, so the note is a comparison against the run
// being read: a card deleted before it was not deleted since it.
function tombstoneNote(deletedAt: string | null, anchor: string | null): string {
  if (deletedAt === null) return '';
  if (anchor === null) return 'deleted';
  return Date.parse(deletedAt) > Date.parse(anchor)
    ? 'deleted since this import'
    : 'deleted before this import';
}

function registerImport(deckCmd: Command, deps: CliDeps): void {
  const importCmd = group(
    'import',
    "A deck's import history from Canva, and clearing a run left open"
  );

  importCmd.addCommand(
    inProject(leaf('status'))
      .description('What the deck was last imported from, and whether a run is open')
      .argument('<deck>', 'deck id or name')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const binding = await readImport(ctx, deck.id);
          const runs = binding === null ? [] : await listRuns(ctx, deck.id);
          ctx.out.data(binding, () => {
            if (binding === null) {
              ctx.out.line(`Nothing has been imported into ${deck.name}`);
              return;
            }
            const open = runs.find((run) => run.id === binding.open_run_id);
            const finished = runs.find((run) => run.status === 'finished');
            ctx.out.line(
              `${deck.name}: last imported from ${binding.source_label ?? 'an unnamed source'}`
            );
            if (finished !== undefined) {
              ctx.out.line(`Last finished: ${runHeading(finished)} (${countsLine(finished)})`);
            }
            if (binding.open_run_id === null) {
              ctx.out.line('No import is open');
            } else {
              const landed =
                open === undefined
                  ? ''
                  : ` — ${String(open.counts.pages)} of ${String(open.page_count)} pages landed`;
              ctx.out.line(
                `Open: ${open === undefined ? shortId(binding.open_run_id) : runHeading(open)}${landed}`
              );
              ctx.out.line(
                `The deck refuses another import until it is finished in Canva or cleared with: threepeaks deck import abandon "${deck.name}"`
              );
            }
          });
        })
      )
  );

  importCmd.addCommand(
    inProject(leaf('runs'))
      .description("List a deck's imports, newest first")
      .argument('<deck>', 'deck id or name')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const runs = await listRuns(ctx, deck.id);
          ctx.out.data(runs, () => {
            if (runs.length === 0) {
              ctx.out.line(`Nothing has been imported into ${deck.name}`);
              return;
            }
            ctx.out.table(
              [
                'ID',
                'STARTED',
                'STATUS',
                'PAGES',
                'ADDED',
                'UPDATED',
                'UNCHANGED',
                'REMOVED',
                'SOURCE',
              ],
              runs.map((run) => [
                shortId(run.id),
                minute(run.started_at),
                run.status,
                `${String(run.counts.pages)}/${String(run.page_count)}`,
                String(run.counts.added),
                String(run.counts.updated),
                String(run.counts.unchanged),
                String(run.counts.removed),
                run.source_label ?? '',
              ])
            );
          });
        })
      )
  );

  importCmd.addCommand(
    inProject(leaf('show'))
      .description('What one import did to each card it touched')
      .argument('<deck>', 'deck id or name')
      .argument('<run>', 'import run id, id prefix, or "latest"')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, runRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const run = matchRun(runRef, await listRuns(ctx, deck.id));
          const detail = assertOk(
            await ctx.api.GET('/api/decks/{deckId}/import/runs/{runId}', {
              params: { path: { deckId: deck.id, runId: run.id } },
            })
          );
          ctx.out.data(detail, () => {
            ctx.out.line(runHeading(detail.run));
            ctx.out.line(countsLine(detail.run));
            if (detail.cards.length === 0) return;
            // Removed first: it is the outcome somebody opens a run to find.
            const rank = (outcome: string) => {
              const index = OUTCOME_ORDER.indexOf(outcome);
              return index === -1 ? OUTCOME_ORDER.length : index;
            };
            const rows = [...detail.cards].sort((a, b) => rank(a.outcome) - rank(b.outcome));
            ctx.out.line();
            ctx.out.table(
              ['OUTCOME', 'PAGE', 'CARD', 'VERSION', 'MATCHED BY', 'NOTE'],
              rows.map((card) => [
                card.outcome,
                card.page_number === null ? '' : String(card.page_number),
                card.name,
                card.file_version_number === null ? '' : `v${String(card.file_version_number)}`,
                card.outcome === 'removed' ? '' : matchLabel(card.matched_by),
                [card.restored ? 'restored' : '', card.file_id === null ? 'purged' : '']
                  .filter((note) => note !== '')
                  .join(', '),
              ])
            );
          });
        })
      )
  );

  importCmd.addCommand(
    inProject(leaf('as-of'))
      .description('The cards the imports had put in the deck as of one finished run')
      .argument('<deck>', 'deck id or name')
      .argument('<run>', 'import run id, id prefix, or "latest"')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, runRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const run = matchRun(runRef, await listRuns(ctx, deck.id));
          const asOf = assertOk(
            await ctx.api.GET('/api/decks/{deckId}/import/runs/{runId}/deck', {
              params: { path: { deckId: deck.id, runId: run.id } },
            })
          );
          ctx.out.data(asOf, () => {
            ctx.out.line(`${deck.name} as of ${runHeading(asOf.run)}`);
            if (asOf.has_purged_history) {
              ctx.out.line(
                'Some artwork in this history has been permanently deleted and cannot be listed.'
              );
            }
            if (asOf.cards.length === 0) {
              ctx.out.line('No cards');
              return;
            }
            ctx.out.line();
            ctx.out.table(
              ['PAGE', 'CARD', 'VERSION', 'LAST CHANGED BY', 'OUTCOME', 'NOTE'],
              asOf.cards.map((card) => [
                card.page_number === null ? '' : String(card.page_number),
                card.name,
                card.file_version_number === null ? '' : `v${String(card.file_version_number)}`,
                shortId(card.last_run_id),
                card.outcome,
                tombstoneNote(card.image_deleted_at, asOf.run.finished_at),
              ])
            );
          });
        })
      )
  );

  importCmd.addCommand(
    inProject(leaf('abandon'))
      .description('Clear an import left open, so the deck accepts the next one')
      .argument('<deck>', 'deck id or name')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const runId = (await readImport(ctx, deck.id))?.open_run_id ?? null;
          // Nothing open is the state this command exists to reach, so it is
          // success rather than an error a script has to special-case.
          if (runId === null) {
            ctx.out.data({ abandoned: null }, () =>
              ctx.out.line(`No import is open for ${deck.name}`)
            );
            return;
          }
          await confirmOrAbort(
            ctx,
            `Abandon the open import into ${deck.name}? Pages already imported keep the versions they wrote.`,
            opts.force === true
          );
          const abandoned = assertOk(
            await ctx.api.POST('/api/decks/import/runs/{runId}/abandon', {
              params: { path: { runId } },
            })
          );
          ctx.out.data({ abandoned }, () =>
            ctx.out.line(
              `Abandoned import ${shortId(abandoned.id)}; ${deck.name} accepts the next import`
            )
          );
        })
      )
  );

  deckCmd.addCommand(importCmd);
}
