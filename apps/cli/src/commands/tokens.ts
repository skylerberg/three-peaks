import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { isLiveCard, withHiddenCards } from '@three-peaks/shared';
import { group, inProject, leaf, optString, withCtx, type Opts } from '../kit.ts';
import { CliError, EXIT, assertDone } from '../errors.ts';
import { parseQuantity } from '../decks.ts';
import {
  matchPiece,
  punchboardPieces,
  saveTokens,
  tokenInput,
  type Piece,
  type PieceSet,
  type TokenInput,
} from '../layouts.ts';
import { placementFromOpts, reorder, sameOrder } from '../placement.ts';
import { projectFromOpts, type Component, type FileRow, type Project } from '../resolve.ts';
import { appendVersion, sendFile, uploadEach, type UploadResult } from '../transfer.ts';
import { shortId } from '../output.ts';
import { fetchComponent, locate } from '../components.ts';
import { pullPieces, pushPieces, renderPieces } from './layout.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

// A punchboard's tokens, which are to it what a deck's cards are to a deck:
// each one a front and a back, a copy count, and a place in the list the sheet
// is packed from. Uploaded here, or drawn from a layout by `tokens push`.

function copiesLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'copy' : 'copies'}`;
}

function backLabel(token: Piece & { back_file_id?: string | null }): string {
  if (token.back_file === null) return 'unprinted back';
  if (token.back_file.id === token.file_id) return 'same image both sides';
  return `back ${token.back_file.filename}${token.back_file.deleted_at === null ? '' : ' (deleted)'}`;
}

// One line per token, as `component show` lists them.
export function tokenLines(tokens: readonly Piece[]): string[] {
  return tokens.map(
    (token, index) =>
      `${String(index + 1).padStart(3)}  ${token.file.filename}  ${copiesLabel(token.quantity)}, ${backLabel(token)}` +
      (isLiveCard(token) ? '' : '  (deleted)')
  );
}

interface Punchboard {
  project: Project;
  component: Component;
  set: PieceSet;
}

async function loadPunchboard(
  ctx: RuntimeContext,
  opts: Opts,
  ref: string,
  deleted: 'allow' | 'refuse' = 'refuse'
): Promise<Punchboard> {
  const project = await projectFromOpts(ctx, opts);
  const component = await locate(ctx, opts, ref, deleted);
  return { project, component, set: punchboardPieces(component) };
}

function inputs(set: PieceSet): TokenInput[] {
  return set.pieces.map(tokenInput);
}

function describeSaved(ctx: RuntimeContext, saved: Component, line: string): void {
  ctx.out.data(saved, () => ctx.out.line(line));
}

// A back several tokens do not share and no layout draws, which choosing
// another back for its token would leave in the punchboard naming nothing.
function ownBack(set: PieceSet, token: Piece): FileRow | null {
  const back = token.back_file;
  if (back === null || back.id === token.file_id || back.deleted_at !== null) return null;
  const shared = set.pieces.some(
    (other) => other.file_id !== token.file_id && other.back_file?.id === back.id
  );
  return shared ? null : back;
}

export function registerTokens(componentCmd: Command, deps: CliDeps): void {
  const tokens = group(
    'tokens',
    "A punchboard's tokens: upload them, set their backs, copies and order, or draw them from layouts"
  );

  tokens.addCommand(
    inProject(leaf('upload'))
      .description('Upload images into a punchboard: each one becomes a token, at the end')
      .argument('<punchboard>', 'punchboard id or name')
      .argument('<paths...>', 'image files to upload')
      .option('--same-back', 'print each image on both sides of its token')
      .option('--replace', 'an image of the same name in the punchboard gets this as a new version')
      .action(
        withCtx(deps, async (ctx, opts, ref, pathsArg) => {
          const paths = pathsArg as unknown as string[];
          const { project, component, set } = await loadPunchboard(ctx, opts, ref);
          const existing = new Map<string, FileRow>();
          for (const token of set.pieces.filter(isLiveCard)) {
            existing.set(token.file.filename.toLowerCase(), token.file);
            if (token.back_file !== null && token.back_file.deleted_at === null) {
              existing.set(token.back_file.filename.toLowerCase(), token.back_file);
            }
          }
          const created: string[] = [];
          try {
            await uploadEach(ctx, paths, component.name, async (path): Promise<UploadResult> => {
              const filename = basename(path);
              const same = existing.get(filename.toLowerCase());
              if (opts.replace === true && same !== undefined) {
                return appendVersion(ctx, same, path);
              }
              const { body } = await sendFile<FileRow>(
                ctx,
                '/api/files/upload',
                { id: randomUUID(), project_id: project.id, component_id: component.id, filename },
                path
              );
              existing.set(body.filename.toLowerCase(), body);
              created.push(body.id);
              return {
                path,
                outcome: 'uploaded',
                file: body,
                file_id: body.id,
                filename: body.filename,
              };
            });
          } finally {
            // The tokens that went up are given their backs even when a later
            // upload failed, so none is left half made.
            if (opts.sameBack === true && created.length > 0) {
              const latest = punchboardPieces(await fetchComponent(ctx, component.id));
              await saveTokens(
                ctx,
                component.id,
                inputs(latest).map((token) =>
                  created.includes(token.file_id)
                    ? { ...token, back_file_id: token.file_id }
                    : token
                )
              );
            }
          }
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('back'))
      .description(
        'Set what is printed behind a token: an image, its own front again, or nothing -- a back it had of its own is deleted, and restorable from the trash'
      )
      .argument('<punchboard>', 'punchboard id or name')
      .argument('<token>', "the token, by its front's filename or id")
      .argument('[path]', 'an image to print behind it; a back it already has gains a version')
      .option('--same', 'print the front on both sides')
      .option('--none', 'leave the board unprinted behind it')
      .action(
        withCtx(deps, async (ctx, opts, ref, tokenRef, path) => {
          const chosen = [path !== undefined, opts.same === true, opts.none === true].filter(
            Boolean
          );
          if (chosen.length !== 1) {
            throw new CliError('Pass an image, --same or --none, one of the three', EXIT.usage);
          }
          const { project, component, set } = await loadPunchboard(ctx, opts, ref);
          const token = matchPiece(set, tokenRef);
          const own = ownBack(set, token);

          if (path !== undefined) {
            if (own !== null) {
              const result = await appendVersion(ctx, own, path);
              ctx.out.data(result, () =>
                ctx.out.line(
                  result.outcome === 'versioned'
                    ? `${token.file.filename}'s back, ${own.filename}, is now version ${String(result.version?.version_number)}`
                    : `${basename(path)} is identical to ${token.file.filename}'s back; nothing changed`
                )
              );
              return;
            }
            // A deleted back still holds the token's place for one; it is let
            // go first, and stays in the trash.
            if (token.back_file !== null && token.back_file.id !== token.file_id) {
              await saveTokens(
                ctx,
                component.id,
                inputs(set).map((entry) =>
                  entry.file_id === token.file_id ? { ...entry, back_file_id: null } : entry
                )
              );
            }
            const { body } = await sendFile<FileRow>(
              ctx,
              '/api/files/upload',
              {
                id: randomUUID(),
                project_id: project.id,
                component_id: component.id,
                role: 'back',
                back_of: token.file_id,
                filename: basename(path),
              },
              path
            );
            ctx.out.data(body, () =>
              ctx.out.line(`Uploaded ${body.filename} as the back of ${token.file.filename}`)
            );
            return;
          }

          const back = opts.same === true ? token.file_id : null;
          if ((token.back_file?.id ?? null) === back) {
            ctx.out.data(component, () =>
              ctx.out.line(`${token.file.filename} already has an ${backLabel(token)}`)
            );
            return;
          }
          if (own !== null) {
            assertDone(
              await ctx.api.DELETE('/api/files/{id}', { params: { path: { id: own.id } } })
            );
            if (!ctx.out.json) {
              ctx.out.line(
                `Deleted ${own.filename}; restore it with: threepeaks trash restore ${own.id}`
              );
            }
          }
          const saved = await saveTokens(
            ctx,
            component.id,
            inputs(set).map((entry) =>
              entry.file_id === token.file_id ? { ...entry, back_file_id: back } : entry
            )
          );
          describeSaved(
            ctx,
            saved,
            `${token.file.filename} now has an ${back === null ? 'unprinted back' : 'image the same on both sides'}`
          );
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('copies'))
      .description('Set how many of a token the punchboard cuts (0 keeps it, cuts none)')
      .argument('<punchboard>', 'punchboard id or name')
      .argument('<token>', "the token, by its front's filename or id")
      .argument('<count>', 'number of copies')
      .action(
        withCtx(deps, async (ctx, opts, ref, tokenRef, count) => {
          const quantity = parseQuantity(count);
          const { component, set } = await loadPunchboard(ctx, opts, ref);
          const token = matchPiece(set, tokenRef);
          if (token.quantity === quantity) {
            ctx.out.data(component, () =>
              ctx.out.line(`${token.file.filename} already has ${copiesLabel(quantity)}`)
            );
            return;
          }
          const saved = await saveTokens(
            ctx,
            component.id,
            inputs(set).map((entry) =>
              entry.file_id === token.file_id ? { ...entry, quantity } : entry
            )
          );
          describeSaved(ctx, saved, `${token.file.filename}: ${copiesLabel(quantity)}`);
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('move'))
      .description('Move a token within the order the sheet is packed in')
      .argument('<punchboard>', 'punchboard id or name')
      .argument('<token>', "the token, by its front's filename or id")
      .option('--top', 'first')
      .option('--bottom', 'last')
      .option('--before <token>', 'directly before this token')
      .option('--after <token>', 'directly after this token')
      .option('--position <n>', 'at this position, counted from 1 as `component show` numbers them')
      .action(
        withCtx(deps, async (ctx, opts, ref, tokenRef) => {
          const { component, set } = await loadPunchboard(ctx, opts, ref);
          const drawn = set.pieces.filter(isLiveCard);
          const live = (name: string): Piece => {
            const token = matchPiece(set, name);
            if (!isLiveCard(token)) {
              throw new CliError(`${token.file.filename} is deleted; restore it first`, EXIT.usage);
            }
            return token;
          };
          const token = live(tokenRef);
          const placement = placementFromOpts(opts);
          const anchor =
            placement.kind === 'before' || placement.kind === 'after'
              ? live(placement.ref).file_id
              : undefined;
          const before = drawn.map((row) => row.file_id);
          const after = reorder(before, token.file_id, placement, anchor);
          const where = `position ${String(after.indexOf(token.file_id) + 1)} of ${String(after.length)}`;
          if (sameOrder(before, after)) {
            ctx.out.data(component, () =>
              ctx.out.line(`${token.file.filename} is already at ${where}`)
            );
            return;
          }
          const byId = new Map(drawn.map((row) => [row.file_id, row]));
          const next = withHiddenCards(
            set.pieces,
            after.map((id) => byId.get(id)!)
          );
          const saved = await saveTokens(ctx, component.id, next.map(tokenInput));
          describeSaved(ctx, saved, `Moved ${token.file.filename} to ${where}`);
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('pull'))
      .description(
        "Write the punchboard's laid-out tokens as YAML: name, layout, copies and fields"
      )
      .argument('<punchboard>', 'punchboard id or name')
      .option('-o, --output <path>', 'file to write (default: stdout)')
      .option('--force', 'overwrite the output file if it exists')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const { project, set } = await loadPunchboard(ctx, opts, ref, 'allow');
          await pullPieces(ctx, project, set, optString(opts, 'output'), opts.force === true);
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('push'))
      .description(
        'Make the punchboard match a tokens file: new tokens are created, changed ones get a new version, and nothing is removed'
      )
      .argument('<punchboard>', 'punchboard id or name')
      .argument('<path>', 'the tokens file, or - for stdin')
      .option('--dry-run', 'say which tokens would be created or changed, changing nothing')
      .action(
        withCtx(deps, async (ctx, opts, ref, path) => {
          const { project, set } = await loadPunchboard(ctx, opts, ref);
          await pushPieces(
            ctx,
            project,
            set,
            path,
            opts.dryRun === true,
            `threepeaks file delete <token> --component "${set.name}"`
          );
        })
      )
  );

  tokens.addCommand(
    inProject(leaf('render'))
      .description(
        "Draw a punchboard's laid-out tokens again from their stored content, and wait for them"
      )
      .argument('<punchboard>', 'punchboard id or name')
      .argument('[token...]', 'only these tokens (default: every live token drawn from a layout)')
      .option(
        '--check',
        'change nothing; list the tokens still waiting to be drawn or that cannot be, and exit non-zero if any are'
      )
      .option('-o, --output <dir>', 'draw the PNGs into a directory, saving nothing')
      .action(
        withCtx(deps, async (ctx, opts, ref, tokensArg) => {
          const { set } = await loadPunchboard(ctx, opts, ref);
          await renderPieces(ctx, set, tokensArg as unknown as string[], {
            check: opts.check === true,
            output: optString(opts, 'output'),
            hint: `threepeaks component tokens push ${shortId(set.id)} <path>`,
          });
        })
      )
  );

  componentCmd.addCommand(tokens);
}
