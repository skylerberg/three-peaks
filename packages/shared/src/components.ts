// A component is a thing in the project that owns its own artwork: a wooden
// piece, a box, a board, a punchboard. It is the other half of the answer to
// "where does this file live" -- a deck owns its cards, a component owns its
// source images, and everything else is a loose asset in the folder tree.
//
// A card is deliberately not here. A card is a member of a deck, so its dial-in
// hangs off the file the way a version does rather than being a thing of its
// own that someone names.

import { MODEL_KINDS, type ModelKind } from './models3d.ts';

export type ComponentKind = Exclude<ModelKind, 'card'>;

// Derived rather than listed again, so a kind added to the studio cannot be one
// the sections forget to offer.
export const COMPONENT_KINDS: readonly ComponentKind[] = MODEL_KINDS.filter(
  (kind): kind is ComponentKind => kind !== 'card'
);

export const COMPONENT_NAME_LIMITS = [1, 120] as const;

// Which file a component's file is. `artwork` is the one image a wooden piece,
// a box or a board is made from; `token` is a face of one of a punchboard's
// tokens, of which it has as many as it has tokens, and which token and which
// face is the `component_token` row's to say.
export const COMPONENT_FILE_ROLES = ['artwork', 'token'] as const;
export type ComponentFileRole = (typeof COMPONENT_FILE_ROLES)[number];

// The roles a kind needs exactly one file in. A punchboard has none: it holds
// a list of tokens instead, and needs at least one of them.
export type ComponentSlotRole = Exclude<ComponentFileRole, 'token'>;

export interface ComponentKindInfo {
  // What the navigation calls the section, and what one of them is called in a
  // sentence.
  section: string;
  singular: string;
  roles: readonly ComponentSlotRole[];
}

export const COMPONENT_KIND_INFO: Record<ComponentKind, ComponentKindInfo> = {
  wood: { section: 'Wooden pieces', singular: 'wooden piece', roles: ['artwork'] },
  box: { section: 'Boxes', singular: 'box', roles: ['artwork'] },
  board: { section: 'Boards', singular: 'board', roles: ['artwork'] },
  punchboard: { section: 'Punchboards', singular: 'punchboard', roles: [] },
};

export function isComponentKind(value: string): value is ComponentKind {
  return (COMPONENT_KINDS as readonly string[]).includes(value);
}

// What a component still needs before it can be built. The studio and the scene
// exporter both refuse a component with an empty answer here, rather than each
// deciding for itself what a complete one looks like.
export function missingRoles(
  kind: ComponentKind,
  present: readonly ComponentFileRole[]
): ComponentSlotRole[] {
  return COMPONENT_KIND_INFO[kind].roles.filter((role) => !present.includes(role));
}

// Whether a component has what it is built from: every slot its kind needs,
// and for a punchboard a token it cuts at least one of. The studio and the
// scene exporter both ask this rather than each deciding for itself.
export function canBuild(component: {
  kind: string;
  missing_roles: readonly string[];
  tokens: readonly { quantity: number; file: { deleted_at: string | null } }[];
}): boolean {
  if (component.missing_roles.length > 0) return false;
  if (component.kind !== 'punchboard') return true;
  return component.tokens.some((token) => token.file.deleted_at === null && token.quantity > 0);
}
