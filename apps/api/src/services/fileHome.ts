import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from 'kysely';
import {
  COMPONENT_KIND_INFO,
  type ComponentFileRole,
  type ComponentKind,
} from '@three-peaks/shared';
import { AppError } from '../utils/errors.ts';
import { type DeletedAncestor, deletedAncestor } from './folderTree.ts';
import type { DB } from '../db/types.ts';
import type { Connection } from '../types/index.ts';

// Where a file lives. Exactly one of the three, which is what the CHECK
// constraints on `file` hold: a deck owns its cards, a component owns its
// source images, and a file naming neither is a loose asset in the folder tree.
//
// Every rule that used to be about a folder is about a home now -- what a name
// has to be unique within, what a tombstone above it hides, what a listing
// shows -- so the dispatch lives here once rather than at each of those.

export type FileHome =
  | { kind: 'folder'; folderId: string | null }
  | { kind: 'deck'; deckId: string }
  | { kind: 'component'; componentId: string; role: ComponentFileRole };

export interface HomeColumns {
  folder_id: string | null;
  deck_id: string | null;
  component_id: string | null;
  component_role: string | null;
}

export function parseHome(row: HomeColumns): FileHome {
  if (row.deck_id !== null) return { kind: 'deck', deckId: row.deck_id };
  if (row.component_id !== null) {
    return {
      kind: 'component',
      componentId: row.component_id,
      role: (row.component_role ?? 'artwork') as ComponentFileRole,
    };
  }
  return { kind: 'folder', folderId: row.folder_id };
}

// What to write for a home. Always all four columns, never a partial update: a
// move that set the new owner without clearing the old one would leave a row
// the CHECK refuses, and one that cleared component_role without component_id
// would leave a role belonging to nothing.
export function homeColumns(home: FileHome): HomeColumns {
  switch (home.kind) {
    case 'folder':
      return {
        folder_id: home.folderId,
        deck_id: null,
        component_id: null,
        component_role: null,
      };
    case 'deck':
      return { folder_id: null, deck_id: home.deckId, component_id: null, component_role: null };
    case 'component':
      return {
        folder_id: null,
        deck_id: null,
        component_id: home.componentId,
        component_role: home.role,
      };
  }
}

export function sameHome(a: FileHome, b: FileHome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'folder' && b.kind === 'folder') return a.folderId === b.folderId;
  if (a.kind === 'deck' && b.kind === 'deck') return a.deckId === b.deckId;
  if (a.kind === 'component' && b.kind === 'component') {
    return a.componentId === b.componentId && a.role === b.role;
  }
  return false;
}

// The predicate that narrows a query on `file` to one home. An expression
// rather than a chain of `.where` calls, so a caller can `and` it with its own.
export function homeFilter(home: FileHome) {
  return (eb: ExpressionBuilder<DB, 'file'>): ExpressionWrapper<DB, 'file', SqlBool> => {
    switch (home.kind) {
      case 'folder':
        return eb.and([
          home.folderId === null
            ? eb('file.folder_id', 'is', null)
            : eb('file.folder_id', '=', home.folderId),
          eb('file.deck_id', 'is', null),
          eb('file.component_id', 'is', null),
        ]);
      case 'deck':
        return eb.and([eb('file.deck_id', '=', home.deckId)]);
      case 'component':
        return eb.and([eb('file.component_id', '=', home.componentId)]);
    }
  };
}

// A loose asset is a file naming no owner, which is the whole of what Assets
// shows. Separate from homeFilter because a directory listing narrows to one
// folder and this narrows to every one of them.
export function unowned(eb: ExpressionBuilder<DB, 'file'>): ExpressionWrapper<DB, 'file', SqlBool> {
  return eb.and([eb('file.deck_id', 'is', null), eb('file.component_id', 'is', null)]);
}

// What stands between a file in this home and being visible. A folder walks its
// ancestors; a deck and a component are one row each, because neither nests.
export async function deletedOwner(
  db: Connection,
  home: FileHome
): Promise<DeletedAncestor | null> {
  switch (home.kind) {
    case 'folder':
      return deletedAncestor(db, home.folderId);
    case 'deck': {
      const row = await db
        .selectFrom('deck')
        .select(['deck.id as id', 'deck.name as name', 'deck.deleted_at as deleted_at'])
        .where('deck.id', '=', home.deckId)
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'Deck not found');
      return row.deleted_at === null ? null : { id: row.id, name: row.name };
    }
    case 'component': {
      const row = await db
        .selectFrom('component')
        .select([
          'component.id as id',
          'component.name as name',
          'component.deleted_at as deleted_at',
        ])
        .where('component.id', '=', home.componentId)
        .executeTakeFirst();
      if (!row) throw new AppError(404, 'Component not found');
      return row.deleted_at === null ? null : { id: row.id, name: row.name };
    }
  }
}

// What a request names as a destination. A deck takes a role too, but not one
// that is stored: a card is a deck_card row and a back is a pointer, so the
// column only ever holds a component's.
export type DeckFileRole = 'card' | 'back';

export interface HomeRequest {
  folder_id?: string | null;
  deck_id?: string | null;
  component_id?: string | null;
  role?: string;
  back_of?: string;
}

export interface ResolvedHome {
  home: FileHome;
  deckRole: DeckFileRole;
  // Into a punchboard, the token (by its front) this file becomes the back of;
  // null makes it a token of its own.
  backOf: string | null;
}

function roleError(role: string, where: string): AppError {
  return new AppError(422, `"${role}" is not a role a ${where} has`);
}

function backOfError(): AppError {
  return new AppError(
    422,
    'back_of names a token, and only the back of a punchboard’s token has one'
  );
}

/**
 * Reads a destination out of a request and checks the caller may write to it:
 * that it exists, that it is in this project, and that no tombstone stands
 * above it. 404 for one the caller cannot see, the way every other lookup here
 * answers -- a 422 naming a real deck would tell a stranger it exists.
 *
 * The project is asserted by the caller before this runs; what this adds is
 * that the destination belongs to that same project.
 */
export async function resolveHome(
  db: Connection,
  projectId: string,
  input: HomeRequest
): Promise<ResolvedHome> {
  const named = [input.deck_id, input.component_id].filter(
    (value) => value !== undefined && value !== null
  );
  if (named.length > 1) {
    throw new AppError(422, 'A file has one home: name a folder, a deck or a component');
  }

  if (input.deck_id !== undefined && input.deck_id !== null) {
    const row = await db
      .selectFrom('deck')
      .select(['deck.id as id', 'deck.deleted_at as deleted_at'])
      .where('deck.id', '=', input.deck_id)
      .where('deck.project_id', '=', projectId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) throw new AppError(404, 'Deck not found');
    const role = input.role ?? 'card';
    if (role !== 'card' && role !== 'back') throw roleError(role, 'deck');
    if (input.back_of !== undefined) throw backOfError();
    return { home: { kind: 'deck', deckId: row.id }, deckRole: role, backOf: null };
  }

  if (input.component_id !== undefined && input.component_id !== null) {
    const row = await db
      .selectFrom('component')
      .select([
        'component.id as id',
        'component.kind as kind',
        'component.deleted_at as deleted_at',
      ])
      .where('component.id', '=', input.component_id)
      .where('component.project_id', '=', projectId)
      .executeTakeFirst();
    if (!row || row.deleted_at !== null) throw new AppError(404, 'Component not found');

    // A punchboard holds tokens: a file arriving is a new token's front, or
    // with `back` the back of one it already has. Either way its role is a
    // token face, and the token list says which.
    if (row.kind === 'punchboard') {
      const role = input.role ?? 'token';
      const home: FileHome = { kind: 'component', componentId: row.id, role: 'token' };
      if (role === 'token') {
        if (input.back_of !== undefined) throw backOfError();
        return { home, deckRole: 'card', backOf: null };
      }
      if (role !== 'back') throw roleError(role, row.kind);
      if (input.back_of === undefined) {
        throw new AppError(422, 'A back names the token it is the back of, as back_of');
      }
      return { home, deckRole: 'card', backOf: input.back_of };
    }

    const role = input.role ?? 'artwork';
    const allowed: readonly string[] = COMPONENT_KIND_INFO[row.kind as ComponentKind]?.roles ?? [];
    if (!allowed.includes(role)) throw roleError(role, row.kind);
    if (input.back_of !== undefined) throw backOfError();
    return {
      home: { kind: 'component', componentId: row.id, role: role as ComponentFileRole },
      deckRole: 'card',
      backOf: null,
    };
  }

  const folderId = input.folder_id ?? null;
  if (folderId !== null) {
    const row = await db
      .selectFrom('folder')
      .select(['folder.id as id'])
      .where('folder.id', '=', folderId)
      .where('folder.project_id', '=', projectId)
      .executeTakeFirst();
    if (!row) throw new AppError(404, 'Folder not found');
    if ((await deletedAncestor(db, folderId)) !== null) {
      throw new AppError(404, 'Folder not found');
    }
  }
  if (input.back_of !== undefined) throw backOfError();
  return { home: { kind: 'folder', folderId }, deckRole: 'card', backOf: null };
}
