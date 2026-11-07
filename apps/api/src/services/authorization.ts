import { type ProjectRole, normalizeProjectRole } from '@three-peaks/shared';
import { AppError } from '../utils/errors.ts';
import type { AppContext } from '../types/index.ts';

export interface ProjectAccess {
  projectId: string;
  role: ProjectRole;
  isCreator: boolean;
}

// The rule this module exists to enforce:
//
//   404 for a caller with no access; 403 only for a caller who can already
//   read the row.
//
// A 403 on a project you cannot see tells you it exists. Every project-scoped
// read goes through assertProjectAccess and every project-scoped mutation
// through assertProjectWrite — a mutating route that asserts only access is a
// defect, not a style choice.
export async function assertProjectAccess(
  c: Pick<AppContext, 'get'>,
  projectId: string
): Promise<ProjectAccess> {
  const db = c.get('db');
  const user = c.get('user');

  const row = await db
    .selectFrom('project as p')
    .leftJoin('project_member as m', (join) =>
      join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', user.id)
    )
    .select(['p.id as id', 'p.created_by as created_by', 'm.role as role'])
    .where('p.id', '=', projectId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Project not found');

  // The creator is an implicit editor and is never stored as a member row, so
  // there is no way to demote or remove them by editing membership.
  if (row.created_by === user.id) {
    return { projectId, role: 'editor', isCreator: true };
  }

  if (row.role === null || row.role === undefined) {
    // Visible to nobody else: same answer as a project that does not exist.
    throw new AppError(404, 'Project not found');
  }

  return { projectId, role: normalizeProjectRole(row.role), isCreator: false };
}

export async function assertProjectWrite(
  c: Pick<AppContext, 'get'>,
  projectId: string
): Promise<ProjectAccess> {
  const access = await assertProjectAccess(c, projectId);
  if (access.role !== 'editor') {
    // 403 is correct here and only here: this caller can already read the row.
    throw new AppError(403, 'You do not have permission to modify this project');
  }
  return access;
}

export async function assertProjectOwner(
  c: Pick<AppContext, 'get'>,
  projectId: string
): Promise<ProjectAccess> {
  const access = await assertProjectAccess(c, projectId);
  if (!access.isCreator) {
    throw new AppError(403, 'Only the project owner can do this');
  }
  return access;
}

// Resolves the project a folder belongs to and asserts access in one round
// trip, so a caller never has to read the row before it is allowed to.
export async function assertFolderAccess(
  c: Pick<AppContext, 'get'>,
  folderId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const db = c.get('db');
  const row = await db
    .selectFrom('folder')
    .select(['folder.project_id as project_id'])
    .where('folder.id', '=', folderId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Folder not found');
  const access =
    mode === 'write'
      ? await assertProjectWrite(c, row.project_id)
      : await assertProjectAccess(c, row.project_id);
  return access;
}

export async function assertFileAccess(
  c: Pick<AppContext, 'get'>,
  fileId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const db = c.get('db');
  const row = await db
    .selectFrom('file')
    .select(['file.project_id as project_id'])
    .where('file.id', '=', fileId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'File not found');
  return mode === 'write'
    ? await assertProjectWrite(c, row.project_id)
    : await assertProjectAccess(c, row.project_id);
}

export async function assertComponentAccess(
  c: Pick<AppContext, 'get'>,
  componentId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const db = c.get('db');
  const row = await db
    .selectFrom('component')
    .select(['component.project_id as project_id'])
    .where('component.id', '=', componentId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Component not found');
  return mode === 'write'
    ? await assertProjectWrite(c, row.project_id)
    : await assertProjectAccess(c, row.project_id);
}

export async function assertDeckAccess(
  c: Pick<AppContext, 'get'>,
  deckId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const db = c.get('db');
  const row = await db
    .selectFrom('deck')
    .select(['deck.project_id as project_id'])
    .where('deck.id', '=', deckId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Deck not found');
  return mode === 'write'
    ? await assertProjectWrite(c, row.project_id)
    : await assertProjectAccess(c, row.project_id);
}

export async function assertLayoutAccess(
  c: Pick<AppContext, 'get'>,
  layoutId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const row = await c
    .get('db')
    .selectFrom('card_layout')
    .select(['card_layout.project_id as project_id'])
    .where('card_layout.id', '=', layoutId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Layout not found');
  return mode === 'write'
    ? await assertProjectWrite(c, row.project_id)
    : await assertProjectAccess(c, row.project_id);
}

export interface ImportAccess extends ProjectAccess {
  deckId: string;
  importId: string;
}

export interface ImportRunAccess extends ImportAccess {
  runId: string;
}

// The whole chain in one query, so the deck's absence and the import's are told
// apart without either being read by somebody not allowed to.
export async function assertImportAccess(
  c: Pick<AppContext, 'get'>,
  deckId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ImportAccess> {
  const row = await c
    .get('db')
    .selectFrom('deck')
    .leftJoin('deck_import', 'deck_import.deck_id', 'deck.id')
    .select(['deck.project_id as project_id', 'deck_import.id as import_id'])
    .where('deck.id', '=', deckId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Deck not found');
  const access =
    mode === 'write'
      ? await assertProjectWrite(c, row.project_id)
      : await assertProjectAccess(c, row.project_id);

  // Asserted first: a stranger must not learn whether this deck has ever been
  // imported into.
  if (row.import_id === null) throw new AppError(404, 'This deck has no import');
  return { ...access, deckId, importId: row.import_id };
}

export async function assertImportRunAccess(
  c: Pick<AppContext, 'get'>,
  runId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ImportRunAccess> {
  const row = await c
    .get('db')
    .selectFrom('import_run')
    .innerJoin('deck_import', 'deck_import.id', 'import_run.import_id')
    .innerJoin('deck', 'deck.id', 'deck_import.deck_id')
    .select(['deck.project_id as project_id', 'deck.id as deck_id', 'deck_import.id as import_id'])
    .where('import_run.id', '=', runId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Import run not found');
  const access =
    mode === 'write'
      ? await assertProjectWrite(c, row.project_id)
      : await assertProjectAccess(c, row.project_id);

  return { ...access, runId, deckId: row.deck_id, importId: row.import_id };
}

export async function assertPrintRunAccess(
  c: Pick<AppContext, 'get'>,
  runId: string,
  mode: 'read' | 'write' = 'read'
): Promise<ProjectAccess> {
  const row = await c
    .get('db')
    .selectFrom('print_run')
    .select(['print_run.project_id as project_id'])
    .where('print_run.id', '=', runId)
    .executeTakeFirst();

  if (!row) throw new AppError(404, 'Print run not found');
  return mode === 'write'
    ? await assertProjectWrite(c, row.project_id)
    : await assertProjectAccess(c, row.project_id);
}

/**
 * Refuses a set of file ids that does not lie entirely inside one project.
 *
 * The ids these guard are stored and never dereferenced -- a card back, a deck's
 * contents -- so without this a row can name a file in a project the caller
 * cannot see, and go on naming it. 422 rather than 404: the request is
 * well-formed and refers to something real, it just does not belong here.
 *
 * One query for the whole set, so a 200-card deck costs the same round trip as
 * a single card back.
 */
export async function assertFilesInProject(
  c: Pick<AppContext, 'get'>,
  fileIds: readonly string[],
  projectId: string,
  what: string
): Promise<void> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return;

  const rows = await c
    .get('db')
    .selectFrom('file')
    .select(['file.id as id'])
    .where('file.id', 'in', unique)
    .where('file.project_id', '=', projectId)
    .execute();

  if (rows.length !== unique.length) {
    throw new AppError(422, `${what} must be a file in the same project`);
  }
}
