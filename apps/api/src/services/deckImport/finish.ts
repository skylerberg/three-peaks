import { sql } from 'kysely';
import { MAX_DECK_CARDS } from '@three-peaks/shared';
import { AppError } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import type { ImportRunAccess } from '../authorization.ts';
import { FILE_COLUMNS, projectStorageUsed, serializeFile } from '../files.ts';
import {
  countDeckCards,
  nextDeckPosition,
  readDeck,
  readDeckCards,
  renumberDeckCards,
} from '../decks.ts';
import { publishAfterCommit } from '../realtime/index.ts';
import {
  assertDeckLive,
  assertOpenRun,
  cardCapError,
  detachMovedCards,
  lockImportFiles,
  lockRun,
  type Ctx,
} from './common.ts';
import { readRun, readRunDetail, runCounts, type RunDetail, type SerializedRun } from './runs.ts';
import type { Connection } from '../../types/index.ts';

// The two ways a run ends. Finishing rewrites the mapping, takes away what the
// export stopped having, and settles the deck's arrangement; abandoning undoes
// none of it -- the pages that landed keep the versions they wrote.

interface TombstonedCard {
  card_id: string;
  file_id: string;
  filename: string;
  version_number: number | null;
}

export async function finishRun(c: Ctx, access: ImportRunAccess): Promise<RunDetail> {
  const db = c.get('db');
  const run = await lockRun(db, access.runId);
  assertOpenRun(run.status);

  await assertDeckLive(db, access.deckId);

  const imported = await countImportedPages(db, access.runId);
  if (imported !== run.page_count) {
    throw new AppError(
      409,
      `This run has imported ${imported} of ${run.page_count} pages. Post the rest, or abandon it.`
    );
  }

  // Ahead of every step after it that writes a mapping row, which is the whole of
  // why it is a step of its own.
  await lockImportFiles(db, access.importId);
  // Again here, for a move made while the run was open.
  await detachMovedCards(db, access.importId, access.deckId);
  await applyPlannedIdentities(db, access.runId);
  const removed = await tombstoneUnmatched(c, access);
  await syncDeckMembership(c, access, removed);
  await orderDeckToExport(c, access);

  // The backstop for the check the run start already made: a hand edit can add
  // cards while the run is open, and past the cap the deck editor can never
  // save again.
  const total = await countDeckCards(db, access.deckId);
  if (total > MAX_DECK_CARDS) throw cardCapError(total);

  const counts = await runCounts(db, access.runId);
  await db
    .updateTable('import_run')
    .set({ status: 'finished', finished_at: new Date(), summary: counts })
    .where('import_run.id', '=', access.runId)
    .execute();
  await db
    .updateTable('deck_import')
    .set({ source_label: run.source_label, updated_at: new Date() })
    .where('deck_import.id', '=', access.importId)
    .execute();

  const hooks = c.get('postCommitHooks');
  const actor = c.get('user').id;
  const [finished, deck, cards] = await Promise.all([
    readRun(c, access.runId),
    readDeck(c, access.deckId),
    readDeckCards(c, access.deckId),
  ]);
  publishAfterCommit(hooks, actor, 'deck_import_finished', access.projectId, {
    deck_id: access.deckId,
    run: finished,
  });
  publishAfterCommit(hooks, actor, 'deck_updated', access.projectId, { deck, cards });

  return await readRunDetail(c, access.importId, access.runId);
}

export async function abandonRun(c: Ctx, access: ImportRunAccess): Promise<SerializedRun> {
  const db = c.get('db');
  const run = await lockRun(db, access.runId);
  assertOpenRun(run.status);

  // Nothing already imported is undone and nothing is tombstoned. The pages
  // that landed keep their files and their mapping rows, and the next run
  // either matches them or removes them -- whichever the export says.
  const counts = await runCounts(db, access.runId);
  await db
    .updateTable('import_run')
    .set({ status: 'abandoned', finished_at: new Date(), summary: counts })
    .where('import_run.id', '=', access.runId)
    .execute();

  const abandoned = await readRun(c, access.runId);
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'deck_import_finished',
    access.projectId,
    {
      deck_id: access.deckId,
      run: abandoned,
    }
  );
  return abandoned;
}

// --- one page ---------------------------------------------------------------

// Every page the run planned has to have landed. The plan is numbered 1..n and
// the unique on (run_id, page_number) admits each of them once, so equality
// with the count means exactly that set and nothing has to be enumerated.
async function countImportedPages(db: Connection, runId: string): Promise<number> {
  const row = await db
    .selectFrom('import_run_card')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('import_run_card.run_id', '=', runId)
    .where('import_run_card.page_number', 'is not', null)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// Two statements, in this order. The first parks every card this run planned
// under a key derived from its own id, which nothing else can hold; the second
// then has an empty index to write into, so it cannot violate whatever the plan
// decided. Nowhere else does a run rewrite a mapping row it did not create.
//
// Only identity_key needs that, because only a title moves between cards -- a
// page slid into the middle of an export shifts every title down one. A page id
// cannot: the tier that matches on it runs first and takes the card already
// holding it, so no other row is left wanting that id.
async function applyPlannedIdentities(db: Connection, runId: string): Promise<void> {
  await db
    .updateTable('deck_import_card')
    .from('import_run_page')
    .set({ identity_key: sql<string>`'p:' || deck_import_card.id::text` })
    .whereRef('import_run_page.card_id', '=', 'deck_import_card.id')
    .where('import_run_page.run_id', '=', runId)
    .execute();

  await db
    .updateTable('deck_import_card')
    .from('import_run_page')
    .set({
      identity_key: (eb) => eb.ref('import_run_page.identity_key'),
      page_number: (eb) => eb.ref('import_run_page.page_number'),
      source_page_id: (eb) => eb.ref('import_run_page.source_page_id'),
    })
    .whereRef('import_run_page.card_id', '=', 'deck_import_card.id')
    .where('import_run_page.run_id', '=', runId)
    .execute();
}

async function tombstoneUnmatched(c: Ctx, access: ImportRunAccess): Promise<TombstonedCard[]> {
  const db = c.get('db');
  const rows: TombstonedCard[] = await db
    .selectFrom('deck_import_card')
    .innerJoin('file', 'file.id', 'deck_import_card.file_id')
    .select((eb) => [
      'deck_import_card.id as card_id',
      'deck_import_card.file_id as file_id',
      'file.filename as filename',
      eb
        .selectFrom('file_version')
        .whereRef('file_version.file_id', '=', 'file.id')
        .select((inner) => inner.fn.max('file_version.version_number').as('n'))
        .as('version_number'),
    ])
    .where('deck_import_card.import_id', '=', access.importId)
    .where('deck_import_card.detached_at', 'is', null)
    // A card tombstoned before this run started was not removed by this run.
    .where('file.deleted_at', 'is', null)
    // The plan, not the ledger: a card no page of this export was planned onto
    // is what the export stopped having.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('import_run_page as claim')
            .select(eb.lit(1).as('matched'))
            .where('claim.run_id', '=', access.runId)
            .whereRef('claim.card_id', '=', 'deck_import_card.id')
        )
      )
    )
    // No lock taken here: lockImportFiles already holds every one of these.
    .execute();

  if (rows.length === 0) return [];

  const goneIds = rows.map((row) => row.file_id);
  await db
    .updateTable('file')
    .set({ deleted_at: new Date(), deleted_by: c.get('user').id })
    .where('file.id', 'in', goneIds)
    .where('file.deleted_at', 'is', null)
    .execute();

  await db
    .insertInto('import_run_card')
    .values(
      rows.map((row) => ({
        id: newId(),
        run_id: access.runId,
        import_card_id: row.card_id,
        outcome: 'removed',
        matched_by: null,
        restored: false,
        page_number: null,
        // Copied off the file: purging the image nulls the link and this is
        // then all the row has left to say which card it was.
        name: row.filename,
        file_version_number: row.version_number ?? 1,
      }))
    )
    .execute();

  // The mapping row is kept, neither detached nor deleted. Keeping it reserves
  // the identity key, and the reserved key is what lets the card come back as a
  // restore rather than as a duplicate three runs later.
  // One usage read for the batch: a per-card fileWithUsage would run two
  // queries for every card an import takes out.
  const used = await projectStorageUsed(c, access.projectId);
  const tombstoned = await c
    .get('db')
    .selectFrom('file')
    .select(FILE_COLUMNS)
    .where(
      'file.id',
      'in',
      rows.map((row) => row.file_id)
    )
    .execute();

  for (const row of tombstoned) {
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'file_deleted',
      access.projectId,
      {
        ...serializeFile(row),
        storage_used_bytes: used,
        purged: false,
      }
    );
  }

  return rows;
}

// The import owns membership only where it created it: it hands over a card it
// has never handed over, and takes back one it has just tombstoned. It never
// puts back a card somebody took out of the deck by hand, and leaves a copy
// count alone as well, bar the one case placeCardInDeck names. Where each card
// then sits is orderDeckToExport's, immediately after.
async function syncDeckMembership(
  c: Ctx,
  access: ImportRunAccess,
  removed: TombstonedCard[]
): Promise<void> {
  const db = c.get('db');

  if (removed.length > 0) {
    await db
      .deleteFrom('deck_card')
      .where('deck_card.deck_id', '=', access.deckId)
      .where(
        'deck_card.file_id',
        'in',
        removed.map((row) => row.file_id)
      )
      .execute();
    await db
      .updateTable('deck_import_card')
      .set({ added_to_deck_at: null })
      .where(
        'deck_import_card.id',
        'in',
        removed.map((row) => row.card_id)
      )
      .execute();
  }

  const pending = await db
    .selectFrom('deck_import_card')
    .innerJoin('file', 'file.id', 'deck_import_card.file_id')
    .select(['deck_import_card.id as card_id', 'deck_import_card.file_id as file_id'])
    .where('deck_import_card.import_id', '=', access.importId)
    .where('deck_import_card.detached_at', 'is', null)
    .where('deck_import_card.added_to_deck_at', 'is', null)
    .where('file.deleted_at', 'is', null)
    .orderBy('deck_import_card.page_number', 'asc')
    .orderBy('deck_import_card.id', 'asc')
    .execute();
  if (pending.length === 0) return;

  const end = await nextDeckPosition(db, access.deckId);

  await db
    .insertInto('deck_card')
    .values(
      pending.map((card, index) => ({
        id: newId(),
        deck_id: access.deckId,
        file_id: card.file_id,
        quantity: 1,
        // Provisional, like every position this import writes before the last
        // step: orderDeckToExport renumbers the whole deck a moment later. It
        // has to be a number the constraint accepts, and the end of the list is
        // the one that is right if this row somehow never reaches that step.
        position: end + index,
      }))
    )
    // One statement, so a hand edit landing at the same moment cannot turn this
    // into a unique violation with five statements still to run.
    .onConflict((oc) => oc.columns(['deck_id', 'file_id']).doNothing())
    .execute();

  await db
    .updateTable('deck_import_card')
    .set({ added_to_deck_at: new Date() })
    .where(
      'deck_import_card.id',
      'in',
      pending.map((card) => card.card_id)
    )
    .execute();
}

// The deck reads in the design's order once a run has finished: the pages as
// the export numbers them, and then every row the export does not account for
// -- a card somebody added by hand, and one they deleted that the design has
// stopped naming -- left in the order it already had.
//
// The order is worked out here and written by renumberDeckCards, which is the
// split worth keeping: what a dense, zero-based arrangement is belongs to the
// deck, and only this end knows that a design decides it. Every position a run
// writes before this one is provisional, because this one runs last.
async function orderDeckToExport(c: Ctx, access: ImportRunAccess): Promise<void> {
  const db = c.get('db');

  const pages = await db
    .selectFrom('import_run_page')
    .innerJoin('deck_import_card', 'deck_import_card.id', 'import_run_page.card_id')
    .select(['deck_import_card.file_id as file_id'])
    .where('import_run_page.run_id', '=', access.runId)
    .orderBy('import_run_page.page_number', 'asc')
    .execute();

  const held = await db
    .selectFrom('deck_card')
    .select([
      'deck_card.id as id',
      'deck_card.file_id as file_id',
      'deck_card.position as position',
    ])
    .where('deck_card.deck_id', '=', access.deckId)
    // readDeckCards' own order, so what trails the pages trails in the order
    // the person was last shown rather than whatever the planner returned.
    .orderBy('deck_card.position', 'asc')
    .orderBy('deck_card.id', 'asc')
    .execute();

  const byFile = new Map(held.map((row) => [row.file_id, row]));
  const placed = new Set<string>();
  const order: typeof held = [];
  for (const page of pages) {
    const row = byFile.get(page.file_id);
    // A page whose card the deck is not holding: purged while the run was open,
    // or moved out of the deck and taken off the list by hand. There is no row
    // to give a place to, and the pages after it close up over the gap.
    if (row === undefined || placed.has(row.id)) continue;
    placed.add(row.id);
    order.push(row);
  }
  for (const row of held) {
    if (!placed.has(row.id)) order.push(row);
  }

  await renumberDeckCards(db, order);
}
