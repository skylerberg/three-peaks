import { AppError, isUniqueViolation } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import type { Ctx } from './common.ts';
import type { Connection } from '../../types/index.ts';

// The `deck_import` row: one per deck, created on first use, and the record of
// which export that deck was last given.

export interface SerializedImport {
  id: string;
  deck_id: string;
  source_label: string | null;
  open_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function readBinding(c: Ctx, deckId: string): Promise<SerializedImport> {
  const row = await c
    .get('db')
    .selectFrom('deck_import')
    .select((eb) => [
      'deck_import.id as id',
      'deck_import.deck_id as deck_id',
      'deck_import.source_label as source_label',
      'deck_import.created_at as created_at',
      'deck_import.updated_at as updated_at',
      eb
        .selectFrom('import_run')
        .whereRef('import_run.import_id', '=', 'deck_import.id')
        .where('import_run.status', '=', 'open')
        .select(['import_run.id as id'])
        .as('open_run_id'),
    ])
    .where('deck_import.deck_id', '=', deckId)
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    deck_id: row.deck_id,
    source_label: row.source_label,
    open_run_id: row.open_run_id ?? null,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

/**
 * The import row for a deck, created on first use.
 *
 * There is nothing to bind any more: a deck owns its cards, so where the
 * artwork lands is the deck itself. What survives is the row that remembers
 * which export this deck was last given, because resuming a run compares the
 * name and the page count against it before a page goes up.
 *
 * A row with no runs is indistinguishable from one that has never existed,
 * which is what makes this safe to call on every start.
 */
export async function ensureImport(c: Ctx, deckId: string): Promise<{ importId: string }> {
  const db = c.get('db');

  const existing = await db
    .selectFrom('deck_import')
    .select(['deck_import.id as id'])
    .where('deck_import.deck_id', '=', deckId)
    .forUpdate()
    .executeTakeFirst();
  if (existing) return { importId: existing.id };

  const id = newId();
  try {
    // source_kind is written because the column is NOT NULL and never read
    // back: there is one source now, and a value nothing branches on says
    // nothing. It goes in the release that drops the column, which cannot be
    // this one -- the release beside it still writes the column itself.
    await db
      .insertInto('deck_import')
      .values({ id, deck_id: deckId, source_kind: 'canva' })
      .execute();
  } catch (error) {
    // Two first imports of one deck at once; the unique on deck_id refuses the
    // second, and the row the first wrote is the one both then use.
    if (isUniqueViolation(error)) {
      const row = await db
        .selectFrom('deck_import')
        .select(['deck_import.id as id'])
        .where('deck_import.deck_id', '=', deckId)
        .executeTakeFirstOrThrow();
      return { importId: row.id };
    }
    throw error;
  }
  return { importId: id };
}

export async function assertNoOpenRun(db: Connection, importId: string): Promise<void> {
  const open = await readOpenRun(db, importId);
  if (open) {
    throw new AppError(409, 'An import run is open for this deck. Finish or abandon it first', {
      run_id: open.id,
      started_at: new Date(open.started_at).toISOString(),
    });
  }
}

async function readOpenRun(db: Connection, importId: string) {
  return await db
    .selectFrom('import_run')
    .select(['import_run.id as id', 'import_run.started_at as started_at'])
    .where('import_run.import_id', '=', importId)
    .where('import_run.status', '=', 'open')
    .executeTakeFirst();
}

// --- runs -------------------------------------------------------------------
