import { COMPONENT_KIND_INFO, type ComponentKind } from '@three-peaks/shared';
import type { Opts } from './kit.ts';
import { CliError, EXIT, assertOk } from './errors.ts';
import {
  UUID_RE,
  listComponents,
  listDeleted,
  matchRefOrNull,
  projectFromOpts,
  type Component,
} from './resolve.ts';
import type { RuntimeContext } from './context.ts';

// Finding one component by what a person typed, shared by the commands that
// act on a component and the ones that act on a punchboard's tokens.

export function kindOf(component: Component): ComponentKind {
  return component.kind as ComponentKind;
}

export function singular(component: Component): string {
  return COMPONENT_KIND_INFO[kindOf(component)].singular;
}

export function label(component: Component): string {
  return `${singular(component)} "${component.name}"`;
}

export async function fetchComponent(ctx: RuntimeContext, componentId: string): Promise<Component> {
  return assertOk(
    await ctx.api.GET('/api/components/{componentId}', { params: { path: { componentId } } })
  );
}

export function restoreHint(component: Component): string {
  return `threepeaks component restore ${component.id}`;
}

// The live listing is where a name is looked up, because two components can
// share a name when one of them is deleted. `deleted` says whether a tombstone
// may answer instead: reading one, saving its settings and purging it are all
// allowed, and anything that changes its contents is not.
export async function locate(
  ctx: RuntimeContext,
  opts: Opts,
  ref: string,
  deleted: 'allow' | 'refuse'
): Promise<Component> {
  let found: Component | null;
  if (UUID_RE.test(ref)) {
    found = await fetchComponent(ctx, ref);
  } else {
    const project = await projectFromOpts(ctx, opts);
    found = matchRefOrNull(
      ref,
      await listComponents(ctx, project.id),
      'component',
      (c) => c.id,
      (c) => c.name
    );
    if (found === null) {
      const tombstone = matchRefOrNull(
        ref,
        (await listDeleted(ctx, project.id)).filter((entry) => entry.kind === 'component'),
        'deleted component',
        (e) => e.id,
        (e) => e.name
      );
      if (tombstone === null) {
        throw new CliError(`No component matching "${ref}" in "${project.name}"`, EXIT.notFound);
      }
      found = await fetchComponent(ctx, tombstone.id);
    }
  }
  if (deleted === 'refuse' && found.deleted_at !== null) {
    throw new CliError(
      `${label(found)} is deleted; restore it first with: ${restoreHint(found)}`,
      EXIT.conflict
    );
  }
  return found;
}
