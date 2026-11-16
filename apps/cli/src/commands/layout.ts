import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  cardFieldErrors,
  isLiveCard,
  layoutReferenceErrors,
  matchingCardPreset,
} from '@three-peaks/shared';
import { collect, group, inProject, leaf, optList, optString, withCtx } from '../kit.ts';
import { CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { shortId } from '../output.ts';
import {
  fetchDeck,
  projectFromOpts,
  resolveComponent,
  resolveDeck,
  type Project,
} from '../resolve.ts';
import { assertAbsent } from '../transfer.ts';
import {
  mapLayoutFiles,
  readCardsDocument,
  readLayoutDocument,
  writeCardsDocument,
  writeLayoutDocument,
  type CardEntry,
} from '../layout/authoring.ts';
import {
  awaitRenders,
  cardFilename,
  cardName,
  checkRenders,
  deckPieces,
  eachCard,
  fetchLayout,
  fetchPieces,
  fileNamer,
  fileResolver,
  listCardContent,
  listLayouts,
  mapImageFields,
  matchLayout,
  matchPiece,
  pieceNoun,
  punchboardPieces,
  pushCards,
  readSource,
  renderStoredCards,
  resolveLayout,
  storedTargets,
  writeFaces,
  writeStoredCards,
  type CardResult,
  type Layout,
  type PieceSet,
  type PlannedCard,
} from '../layouts.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

function sizeText(layout: { width_mm: number; height_mm: number }): string {
  const preset = matchingCardPreset(layout);
  const mm = `${String(layout.width_mm)} × ${String(layout.height_mm)} mm`;
  return preset === undefined ? mm : `${preset.id} (${mm})`;
}

function invalid(source: string, errors: readonly string[]): CliError {
  return new CliError(
    [`${source} is not valid:`, ...errors.map((e) => `  ${e}`)].join('\n'),
    EXIT.invalid
  );
}

// Written to a file, never over one without --force, or to stdout.
async function emit(ctx: RuntimeContext, text: string, output: string | undefined, force: boolean) {
  if (output === undefined || output === '-') {
    ctx.out.line(text.replace(/\n$/, ''));
    return;
  }
  if (!force) await assertAbsent(output);
  await writeFile(output, text);
  ctx.out.error(`Wrote ${output}`);
}

// A layout file read and every file it names looked up, ready to send or draw.
async function loadLayoutFile(ctx: RuntimeContext, project: Project, path: string) {
  const document = readLayoutDocument(await readSource(ctx, path), path);
  const spec = await mapLayoutFiles(document.spec, fileResolver(ctx, project));
  const errors = layoutReferenceErrors(spec);
  if (errors.length > 0) throw invalid(path, errors);
  return { ...document, spec };
}

// A cards file read, each card matched to its layout and its images looked
// up -- and every value checked against that layout before anything is sent,
// so a typo in the fortieth card does not land after thirty-nine uploads.
async function loadCardsFile(
  ctx: RuntimeContext,
  project: Project,
  path: string,
  layoutFor: (entry: CardEntry) => Layout | null
): Promise<PlannedCard[]> {
  const entries = readCardsDocument(await readSource(ctx, path), path);
  const resolve = fileResolver(ctx, project);
  const errors: string[] = [];
  const planned: PlannedCard[] = [];
  for (const entry of entries) {
    const layout = layoutFor(entry);
    if (layout === null) continue;
    const fields = await mapImageFields(layout, entry.fields, (ref, key) =>
      resolve(ref, `${entry.name}: ${key}`)
    );
    for (const message of cardFieldErrors(layout.spec, fields))
      errors.push(`${entry.name}: ${message}`);
    planned.push({
      name: entry.name,
      filename: cardFilename(entry.name),
      layout,
      copies: entry.copies,
      fields,
    });
  }
  if (errors.length > 0) throw invalid(path, errors);
  return planned;
}

// The cards of every deck and the tokens of every punchboard drawn from this
// layout, as they were before a save asked for them to be drawn again -- what
// the wait afterwards measures "new" against.
async function dependants(ctx: RuntimeContext, layoutId: string) {
  const { decks, punchboards } = await fetchLayout(ctx, layoutId);
  const sets = await Promise.all([
    ...decks.map((deck) => fetchPieces(ctx, { kind: 'deck', id: deck.id })),
    ...punchboards.map((board) => fetchPieces(ctx, { kind: 'punchboard', id: board.id })),
  ]);
  return Promise.all(
    sets.map(async (set) => ({
      set,
      targets: storedTargets(set, await listCardContent(ctx, set), { layoutId }),
    }))
  );
}

// Waits for the API to draw each deck's cards and punchboard's tokens again.
// One that fails does not stop the next; the first failure is what the command
// ends on.
async function awaitDependants(ctx: RuntimeContext, sets: Awaited<ReturnType<typeof dependants>>) {
  const rendered: { deck: string; results: CardResult[] }[] = [];
  let error: CliError | null = null;
  for (const { set, targets } of sets) {
    if (!ctx.out.json) {
      ctx.out.line(`${set.name}: ${String(targets.length)} ${pieceNoun(set, true)}`);
    }
    const run = await awaitRenders(ctx, set, targets);
    rendered.push({ deck: set.name, results: run.results });
    error ??= run.error;
  }
  return { rendered, error };
}

export function registerLayout(program: Command, deps: CliDeps): void {
  const layoutCmd = group('layout', 'Card layouts: the frame, art and copy cards are drawn from');

  layoutCmd.addCommand(
    inProject(leaf('list'))
      .description('List the card layouts in a project')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const project = await projectFromOpts(ctx, opts);
          const layouts = await listLayouts(ctx, project.id);
          ctx.out.data(layouts, () => {
            if (layouts.length === 0) {
              ctx.out.line(
                `No layouts in "${project.name}". Write one and: threepeaks layout push <path>`
              );
              return;
            }
            ctx.out.table(
              ['ID', 'NAME', 'SIZE', 'FIELDS', 'ELEMENTS'],
              layouts.map((layout) => [
                shortId(layout.id),
                layout.name,
                sizeText(layout),
                Object.keys(layout.spec.fields).join(', '),
                String(layout.spec.elements.length),
              ])
            );
          });
        })
      )
  );

  layoutCmd.addCommand(
    inProject(leaf('show'))
      .description(
        'Show a layout: its size, fields, files, and the decks and punchboards drawn from it'
      )
      .argument('<layout>', 'layout id or name')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const detail = await fetchLayout(ctx, (await resolveLayout(ctx, project.id, ref)).id);
          const name = fileNamer(ctx);
          const { layout } = detail;
          const files = async (record: Record<string, string>) =>
            Promise.all(
              Object.entries(record).map(async ([key, id]) => `${key} = ${await name(id)}`)
            );
          const [fonts, icons] = await Promise.all([
            files(layout.spec.fonts),
            files(layout.spec.icons),
          ]);
          ctx.out.data(detail, () => {
            ctx.out.line(
              `${layout.name} (${shortId(layout.id)}) — ${sizeText(layout)} at ${String(layout.spec.dpi)} dpi`
            );
            const fields = Object.entries(layout.spec.fields).map(
              ([key, field]) => `${key} (${field.type})`
            );
            ctx.out.line(`Fields: ${fields.length === 0 ? 'none' : fields.join(', ')}`);
            ctx.out.line(`Fonts: ${fonts.length === 0 ? 'none' : fonts.join(', ')}`);
            ctx.out.line(`Icons: ${icons.length === 0 ? 'none' : icons.join(', ')}`);
            ctx.out.line(
              layout.spec.back === null
                ? `Elements: ${String(layout.spec.elements.length)}`
                : `Elements: ${String(layout.spec.elements.length)} on the front, ${String(layout.spec.back.length)} on the back`
            );
            const users = [
              ...detail.decks.map((deck) => `${deck.name} (${String(deck.card_count)})`),
              ...detail.punchboards.map(
                (board) => `${board.name} (${String(board.token_count)} tokens)`
              ),
            ];
            ctx.out.line(
              users.length === 0
                ? 'No live cards or tokens are drawn from it'
                : `Drawn from by: ${users.join(', ')}`
            );
          });
        })
      )
  );

  layoutCmd.addCommand(
    inProject(leaf('pull'))
      .description('Write a layout out as YAML, naming its files by their Assets paths')
      .argument('<layout>', 'layout id or name')
      .option('-o, --output <path>', 'file to write (default: stdout)')
      .option('--force', 'overwrite the output file if it exists')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const layout = await resolveLayout(ctx, project.id, ref);
          if (ctx.out.json) {
            ctx.out.line(JSON.stringify(layout, null, 2));
            return;
          }
          const name = fileNamer(ctx);
          const spec = await mapLayoutFiles(layout.spec, (id) => name(id));
          const text = writeLayoutDocument({ ...layout, spec });
          await emit(ctx, text, optString(opts, 'output'), opts.force === true);
        })
      )
  );

  layoutCmd.addCommand(
    inProject(leaf('push'))
      .description(
        'Create a layout from a YAML file, or replace the one of the same name; the cards drawn from it are drawn again, and this waits for them'
      )
      .argument('<path>', 'the layout file, or - for stdin')
      .option('--layout <layout>', 'replace this layout, renaming it to the name in the file')
      .option('--no-wait', 'save the layout and return while its cards are still being drawn')
      .action(
        withCtx(deps, async (ctx, opts, path) => {
          const project = await projectFromOpts(ctx, opts);
          const document = await loadLayoutFile(ctx, project, path);
          const layouts = await listLayouts(ctx, project.id);
          const target = optString(opts, 'layout');
          const existing =
            target !== undefined
              ? matchLayout(target, layouts)
              : layouts.find((layout) => layout.name.toLowerCase() === document.name.toLowerCase());
          const body = {
            name: document.name,
            width_mm: document.width_mm,
            height_mm: document.height_mm,
            spec: document.spec,
          };
          const wait = opts.wait !== false && existing !== undefined;
          const before = wait ? await dependants(ctx, existing.id) : [];
          const saved =
            existing === undefined
              ? assertOk(
                  await ctx.api.POST('/api/layouts', {
                    body: { ...body, id: randomUUID(), project_id: project.id },
                  })
                )
              : assertOk(
                  await ctx.api.PUT('/api/layouts/{layoutId}', {
                    params: { path: { layoutId: existing.id } },
                    body,
                  })
                );
          if (!ctx.out.json) {
            ctx.out.line(
              `${existing === undefined ? 'Created' : 'Updated'} layout ${saved.name} (${shortId(saved.id)})`
            );
          }
          const { rendered, error } = wait
            ? await awaitDependants(ctx, before)
            : { rendered: [], error: null };
          if (ctx.out.json) ctx.out.line(JSON.stringify({ layout: saved, rendered }, null, 2));
          if (error !== null) throw error;
        })
      )
  );

  layoutCmd.addCommand(
    inProject(leaf('preview'))
      .description(
        'Draw cards from a layout file into a directory, saving nothing -- for iterating on a layout before pushing it'
      )
      .argument('<path>', 'the layout file')
      .argument('[cards-file]', 'a cards file; its cards naming this layout are drawn')
      .option('--deck <deck>', "draw this deck's stored cards that use a layout of the same name")
      .option(
        '--punchboard <punchboard>',
        "draw this punchboard's stored tokens that use a layout of the same name"
      )
      .option('--card <name>', 'only this card (repeatable)', collect)
      .requiredOption('-o, --output <dir>', 'directory to write the PNGs into')
      .action(
        withCtx(deps, async (ctx, opts, path, cardsPath) => {
          const project = await projectFromOpts(ctx, opts);
          const document = await loadLayoutFile(ctx, project, path);
          const deckRef = optString(opts, 'deck');
          const boardRef = optString(opts, 'punchboard');
          const sources = [cardsPath, deckRef, boardRef].filter((source) => source !== undefined);
          if (sources.length !== 1) {
            throw new CliError(
              'Pass a cards file, --deck or --punchboard, one of the three',
              EXIT.usage
            );
          }
          const preview: Layout = {
            ...document,
            id: 'preview',
            project_id: project.id,
            created_by: null,
            updated_by: null,
            created_at: '',
            updated_at: '',
          };
          const sameName = (name: string) => name.toLowerCase() === document.name.toLowerCase();

          let cards: { name: string; fields: Record<string, string> }[];
          if (cardsPath !== undefined) {
            const planned = await loadCardsFile(ctx, project, cardsPath, (entry) =>
              sameName(entry.layout) ? preview : null
            );
            cards = planned.map((card) => ({ name: card.filename, fields: card.fields }));
          } else {
            const set =
              deckRef !== undefined
                ? deckPieces(await fetchDeck(ctx, (await resolveDeck(ctx, project.id, deckRef)).id))
                : punchboardPieces(await resolveComponent(ctx, project.id, boardRef!));
            if (preview.width_mm !== set.width_mm || preview.height_mm !== set.height_mm) {
              throw new CliError(
                `${preview.name} is drawn on a ${sizeText(preview)} card and ${set.name}'s ${pieceNoun(set, true)} are ${sizeText(set)}`,
                EXIT.invalid
              );
            }
            const layouts = new Map((await listLayouts(ctx, project.id)).map((l) => [l.id, l]));
            cards = storedTargets(set, await listCardContent(ctx, set))
              .filter(({ content }) => sameName(layouts.get(content.layout_id)?.name ?? ''))
              .map(({ piece, content }) => ({ name: piece.file.filename, fields: content.fields }));
          }
          const only = optList(opts, 'card').map((name) => cardFilename(name).toLowerCase());
          if (only.length > 0)
            cards = cards.filter((card) => only.includes(card.name.toLowerCase()));
          if (cards.length === 0) {
            throw new CliError(`No cards to draw with ${document.name}`, EXIT.notFound);
          }

          const output = optString(opts, 'output')!;
          await mkdir(output, { recursive: true });
          const run = await eachCard(
            ctx,
            cards,
            (card) => card.name,
            async (card) => {
              const [target] = await writeFaces(
                ctx,
                project.id,
                preview,
                card.fields,
                output,
                card.name
              );
              return { card: card.name, file_id: null, outcome: 'written', path: target };
            }
          );
          if (ctx.out.json) ctx.out.line(JSON.stringify(run.results, null, 2));
          if (run.error !== null) throw run.error;
        })
      )
  );

  layoutCmd.addCommand(
    inProject(leaf('delete'))
      .description('Delete a layout no card is drawn from; it owns no files, so this is permanent')
      .argument('<layout>', 'layout id or name')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const layout = await resolveLayout(ctx, project.id, ref);
          await confirmOrAbort(ctx, `Delete layout ${layout.name} for good?`, opts.force === true);
          assertDone(
            await ctx.api.DELETE('/api/layouts/{layoutId}', {
              params: { path: { layoutId: layout.id } },
            })
          );
          ctx.out.data({ id: layout.id, deleted: true }, () =>
            ctx.out.line(`Deleted layout ${layout.name}`)
          );
        })
      )
  );

  program.addCommand(layoutCmd);
}

// Pulling, pushing and drawing again, for a deck's cards or a punchboard's
// tokens alike: both are pieces drawn from layouts, and a cards file names a
// token the way it names a card.

export async function pullPieces(
  ctx: RuntimeContext,
  project: Project,
  set: PieceSet,
  output: string | undefined,
  force: boolean
): Promise<void> {
  const [contents, layouts] = await Promise.all([
    listCardContent(ctx, set),
    listLayouts(ctx, project.id),
  ]);
  const byId = new Map(layouts.map((layout) => [layout.id, layout]));
  const targets = storedTargets(set, contents);
  if (ctx.out.json) {
    ctx.out.line(
      JSON.stringify(
        targets.map(({ content }) => content),
        null,
        2
      )
    );
    return;
  }
  const name = fileNamer(ctx);
  const entries = await Promise.all(
    targets.map(async ({ piece, content }) => {
      const layout = byId.get(content.layout_id)!;
      return {
        name: cardName(piece.file.filename),
        layout: layout.name,
        copies: piece.quantity,
        fields: await mapImageFields(layout, content.fields, (id) => name(id)),
      };
    })
  );
  await emit(
    ctx,
    writeCardsDocument(entries, set.kind === 'deck' ? 'cards' : 'tokens'),
    output,
    force
  );
}

export async function pushPieces(
  ctx: RuntimeContext,
  project: Project,
  set: PieceSet,
  path: string,
  dryRun: boolean,
  deleteHint: string
): Promise<void> {
  const layouts = await listLayouts(ctx, project.id);
  const planned = await loadCardsFile(ctx, project, path, (entry) =>
    matchLayout(entry.layout, layouts)
  );
  const run = await pushCards(ctx, set, planned, { dryRun });

  // Nothing is removed, but a piece this file has stopped naming is worth a
  // line: it is still there and still prints.
  const named = new Set(planned.map((card) => card.filename.toLowerCase()));
  const left = storedTargets(set, await listCardContent(ctx, set))
    .map(({ piece }) => piece.file.filename)
    .filter((filename) => !named.has(filename.toLowerCase()));
  if (ctx.out.json) {
    ctx.out.line(JSON.stringify({ cards: run.results, not_in_file: left }, null, 2));
  } else if (left.length > 0) {
    ctx.out.line();
    ctx.out.line(`Not in ${path}, and left as they are: ${left.join(', ')}`);
    ctx.out.line(`Delete one with: ${deleteHint}`);
  }
  if (run.error !== null) throw run.error;
}

export async function renderPieces(
  ctx: RuntimeContext,
  set: PieceSet,
  refs: readonly string[],
  options: { check: boolean; output: string | undefined; hint: string }
): Promise<void> {
  if (options.check && options.output !== undefined) {
    throw new CliError('Pass --check or --output, not both', EXIT.usage);
  }
  const noun = pieceNoun(set);
  const pieces = refs.length === 0 ? undefined : refs.map((ref) => matchPiece(set, ref));
  for (const piece of pieces ?? []) {
    if (!isLiveCard(piece)) {
      throw new CliError(`${piece.file.filename}'s image is deleted; restore it first`, EXIT.usage);
    }
  }
  const targets = storedTargets(set, await listCardContent(ctx, set), { pieces });
  if (targets.length === 0) {
    ctx.out.data([], () =>
      ctx.out.line(
        pieces === undefined
          ? `No ${noun} in ${set.name} is drawn from a layout. Add some with: ${options.hint}`
          : `None of those ${pieceNoun(set, true)} is drawn from a layout`
      )
    );
    return;
  }
  const run = options.check
    ? await checkRenders(ctx, targets)
    : options.output !== undefined
      ? await writeStoredCards(ctx, set, targets, options.output)
      : await renderStoredCards(ctx, set, targets);
  if (ctx.out.json) ctx.out.line(JSON.stringify(run.results, null, 2));
  if (run.error !== null) throw run.error;
}

// The deck half: a deck's cards as a file, that file pushed back, and the
// stored cards re-rendered. Registered by the deck group so they read as what
// they act on.
export function registerDeckCards(deckCmd: Command, deps: CliDeps): void {
  const cardsCmd = group('cards', "A deck's cards drawn from layouts, as a YAML file");

  cardsCmd.addCommand(
    inProject(leaf('pull'))
      .description("Write the deck's laid-out cards as YAML: name, layout, copies and fields")
      .argument('<deck>', 'deck id or name')
      .option('-o, --output <path>', 'file to write (default: stdout)')
      .option('--force', 'overwrite the output file if it exists')
      .action(
        withCtx(deps, async (ctx, opts, deckRef) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const set = deckPieces(await fetchDeck(ctx, deck.id));
          await pullPieces(ctx, project, set, optString(opts, 'output'), opts.force === true);
        })
      )
  );

  cardsCmd.addCommand(
    inProject(leaf('push'))
      .description(
        'Make the deck match a cards file: new cards are created, changed ones get a new version, and nothing is removed'
      )
      .argument('<deck>', 'deck id or name')
      .argument('<path>', 'the cards file, or - for stdin')
      .option('--dry-run', 'say which cards would be created or changed, changing nothing')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, path) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const set = deckPieces(await fetchDeck(ctx, deck.id));
          await pushPieces(
            ctx,
            project,
            set,
            path,
            opts.dryRun === true,
            `threepeaks file delete <card> --deck "${set.name}"`
          );
        })
      )
  );

  deckCmd.addCommand(cardsCmd);

  deckCmd.addCommand(
    inProject(leaf('render'))
      .description(
        "Draw a deck's laid-out cards again from their stored content, and wait for them. The API does this itself when a layout or a file the cards draw changes; this is for anything it cannot see"
      )
      .argument('<deck>', 'deck id or name')
      .argument('[card...]', 'only these cards (default: every live card drawn from a layout)')
      .option(
        '--check',
        'change nothing; list the cards still waiting to be drawn or that cannot be, and exit non-zero if any are'
      )
      .option('-o, --output <dir>', 'draw the PNGs into a directory, saving nothing')
      .action(
        withCtx(deps, async (ctx, opts, deckRef, cardsArg) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, deckRef);
          const set = deckPieces(await fetchDeck(ctx, deck.id));
          await renderPieces(ctx, set, cardsArg as unknown as string[], {
            check: opts.check === true,
            output: optString(opts, 'output'),
            hint: 'threepeaks deck cards push',
          });
        })
      )
  );
}
