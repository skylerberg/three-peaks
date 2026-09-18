import { sql } from 'kysely';
import { MAX_DECK_CARDS } from '@three-peaks/shared';
import { AppError } from '../../utils/errors.ts';
import { blockedMessage } from '../folderTree.ts';
import type { AppContext, Connection } from '../../types/index.ts';

// The pieces more than one step of an import needs: the context alias, the
// three refusals every entry point repeats, and the two locks that order a run
// against a purge. Nothing here knows which step is calling it.

export type Ctx = Pick<AppContext, 'get'>;

export function assertOpenRun(status: string): void {
  if (status !== 'open') throw new AppError(409, 'That import run is closed');
}

// Importing writes to the deck's contents, and a tombstone refuses those.
export async function assertDeckLive(db: Connection, deckId: string): Promise<void> {
  const row = await db
    .selectFrom('deck')
    .select(['deck.id as id', 'deck.name as name', 'deck.deleted_at as deleted_at'])
    .where('deck.id', '=', deckId)
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'Deck not found');
  if (row.deleted_at !== null) {
    throw new AppError(409, blockedMessage({ id: row.id, name: row.name }, 'This import'));
  }
}

// --- the import row ---------------------------------------------------------

export function cardCapError(total: number): AppError {
  return new AppError(
    422,
    `This import would leave the deck holding ${total} cards, and a deck holds at most ${MAX_DECK_CARDS}`,
    { cards: total, limit: MAX_DECK_CARDS }
  );
}

export async function lockRun(db: Connection, runId: string) {
  return await db
    .selectFrom('import_run')
    .select([
      'import_run.status as status',
      'import_run.page_count as page_count',
      'import_run.source_label as source_label',
    ])
    .where('import_run.id', '=', runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

// Every file this import owns, locked in id order and before any mapping row is
// touched. Ascending id is the order every bulk file lock in the repo takes --
// a folder purge's and a project delete's -- and both of those then reach
// deck_import_card through the cascade, so taking the mapping first here is
// what would leave the two waiting on each other.
//
// One cycle is left open, and it is older than this import rather than
// something the ordering here closes: finishing writes deck_card while holding these
// locks, whereas replacing a deck's cards by hand rewrites deck_card first and
// only then takes the key-share its foreign key needs on each file. A purge
// contends with that hand edit exactly the same way. Postgres breaks it and one
// of the two transactions retries; closing it means locking the files a deck's
// cards name from routes/decks.ts, which is a change to that route.
export async function lockImportFiles(db: Connection, importId: string): Promise<void> {
  await db
    .selectFrom('deck_import_card')
    .innerJoin('file', 'file.id', 'deck_import_card.file_id')
    .select(['file.id as id'])
    .where('deck_import_card.import_id', '=', importId)
    .forUpdate('file')
    .orderBy('file.id')
    .execute();
}

// Derived rather than stamped when a file is moved, which also catches a move
// made by a pod on the previous release. Runs both when a run starts and when
// it finishes, and before finish.ts re-keys the mapping either way, so a
// detached row has already left the partial unique index.
export async function detachMovedCards(
  db: Connection,
  importId: string,
  deckId: string
): Promise<void> {
  await db
    .updateTable('deck_import_card')
    .from('file')
    .set({ detached_at: new Date() })
    .whereRef('file.id', '=', 'deck_import_card.file_id')
    .where('deck_import_card.import_id', '=', importId)
    .where('deck_import_card.detached_at', 'is', null)
    .where(sql<boolean>`file.deck_id is distinct from ${deckId}::uuid`)
    .execute();
}
