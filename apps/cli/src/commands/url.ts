import { Argument, type Command } from 'commander';
import { COMPONENT_KINDS } from '@three-peaks/shared';
import { group, inProject, leaf, optString, withCtx, type Opts } from '../kit.ts';
import { CliError, EXIT } from '../errors.ts';
import { normalizeBaseUrl } from '../config.ts';
import {
  fileScopeFromOpts,
  projectFromOpts,
  resolveComponent,
  resolveDeck,
  resolveFileRef,
  resolveFolderPath,
  resolveProject,
} from '../resolve.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

// Only the web app's own route shapes: apps/web/src/lib/router.svelte.ts is
// what these have to agree with, and every one of them is addressed by id so a
// rename never breaks a link somebody pasted.
function printUrl(ctx: RuntimeContext, path: string): void {
  const url = `${normalizeBaseUrl(ctx.webUrl, 'web URL')}${path}`;
  ctx.out.data({ url }, () => ctx.out.line(url));
}

function projectLeaf(name: string, description: string): Command {
  return inProject(leaf(name).description(description));
}

async function projectPath(ctx: RuntimeContext, opts: Opts): Promise<string> {
  return `/projects/${(await projectFromOpts(ctx, opts)).id}`;
}

export function registerUrl(program: Command, deps: CliDeps): void {
  const url = group('url', 'Print the web app link to a project, deck, component, folder or file');

  url.addCommand(
    leaf('project')
      .description('Link to a project')
      .argument('[project]', 'project id or name (default: the configured project)')
      .action(
        withCtx(deps, async (ctx, _opts, ref) => {
          printUrl(ctx, `/projects/${(await resolveProject(ctx, ref)).id}`);
        })
      )
  );

  url.addCommand(
    projectLeaf('members', 'Link to a project’s members screen').action(
      withCtx(deps, async (ctx, opts) => printUrl(ctx, `${await projectPath(ctx, opts)}/members`))
    )
  );

  url.addCommand(
    projectLeaf('trash', 'Link to a project’s Deleted screen').action(
      withCtx(deps, async (ctx, opts) => printUrl(ctx, `${await projectPath(ctx, opts)}/deleted`))
    )
  );

  url.addCommand(
    projectLeaf('folder', 'Link to a folder in Assets, or to Assets itself')
      .argument('[folder]', 'folder path such as Art/Cards, or a folder id (default: the root)')
      .action(
        withCtx(deps, async (ctx, opts, path) => {
          const project = await projectFromOpts(ctx, opts);
          const { folder } = await resolveFolderPath(ctx, project.id, path ?? '');
          printUrl(
            ctx,
            `/projects/${project.id}/assets${folder === null ? '' : `?folder=${folder.id}`}`
          );
        })
      )
  );

  url.addCommand(
    projectLeaf('decks', 'Link to a project’s decks').action(
      withCtx(deps, async (ctx, opts) => printUrl(ctx, `${await projectPath(ctx, opts)}/decks`))
    )
  );

  url.addCommand(
    projectLeaf('deck', 'Link to a deck’s editor')
      .argument('<deck>', 'deck id or name')
      .option('--history', 'link to its import history instead')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const deck = await resolveDeck(ctx, project.id, ref);
          const suffix = opts.history === true ? '/history' : '';
          printUrl(ctx, `/projects/${project.id}/decks/${deck.id}${suffix}`);
        })
      )
  );

  url.addCommand(
    projectLeaf('print', 'Link to the print screen, with one deck already ticked if named')
      .option('--deck <deck>', 'deck id or name to pre-select')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const project = await projectFromOpts(ctx, opts);
          const deckRef = optString(opts, 'deck');
          const query =
            deckRef === undefined
              ? ''
              : `?deck=${(await resolveDeck(ctx, project.id, deckRef)).id}`;
          printUrl(ctx, `/projects/${project.id}/print${query}`);
        })
      )
  );

  url.addCommand(
    projectLeaf('scene', 'Link to the Blender scene export').action(
      withCtx(deps, async (ctx, opts) => printUrl(ctx, `${await projectPath(ctx, opts)}/scene`))
    )
  );

  url.addCommand(
    projectLeaf('section', 'Link to one section of components')
      .addArgument(new Argument('<kind>', 'which section').choices([...COMPONENT_KINDS]))
      .action(
        withCtx(deps, async (ctx, opts, kind) =>
          printUrl(ctx, `${await projectPath(ctx, opts)}/components/${kind}`)
        )
      )
  );

  url.addCommand(
    projectLeaf('component', 'Link to a component’s 3D studio')
      .argument('<component>', 'component id or name')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const component = await resolveComponent(ctx, project.id, ref);
          printUrl(ctx, `/projects/${project.id}/components/${component.id}`);
        })
      )
  );

  url.addCommand(
    projectLeaf('file', 'Link to a file’s version history, or a card’s 3D studio with --3d')
      .argument('<file>', 'file id, Assets path, or a name within --deck or --component')
      .option('--deck <deck>', 'look the file up among this deck’s cards')
      .option('--component <component>', 'look the file up among this component’s files')
      .option('--3d', 'link to the 3D studio for a deck card')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const file = await resolveFileRef(
            ctx,
            ref,
            fileScopeFromOpts(opts),
            optString(opts, 'project')
          );
          if (opts['3d'] === true) {
            // A component is dialled in on its own screen; only a card's dial-in
            // hangs off the file.
            if (file.deck_id === null) {
              throw new CliError(
                `${file.filename} is not a deck card; a component's studio is: threepeaks url component`,
                EXIT.usage
              );
            }
            printUrl(ctx, `/projects/${file.project_id}/files/${file.id}/3d`);
            return;
          }
          printUrl(ctx, `/projects/${file.project_id}/files/${file.id}/versions`);
        })
      )
  );

  program.addCommand(url);
}
