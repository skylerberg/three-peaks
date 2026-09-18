import { sql } from 'kysely';
import type { ImportRunSummary } from '@three-peaks/shared';
import { AppError } from '../../utils/errors.ts';
import type { Ctx } from './common.ts';
import type { Connection } from '../../types/index.ts';

// Reading runs back: one run, a deck's whole timeline, and the rows of a single
// run. The counts are derived off the ledger on every read rather than taken
// from the cached column, so the two can never be seen disagreeing.

export interface SerializedRun {
  id: string;
  import_id: string;
  status: string;
  source_label: string | null;
  page_count: number;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  counts: ImportRunSummary;
}

interface SerializedRunCard {
  page_number: number | null;
  outcome: string;
  matched_by: string | null;
  restored: boolean;
  name: string;
  file_id: string | null;
  file_version_number: number | null;
}

export interface RunDetail {
  run: SerializedRun;
  cards: SerializedRunCard[];
}

const RUN_COLUMNS = [
  'import_run.id as id',
  'import_run.import_id as import_id',
  'import_run.status as status',
  'import_run.source_label as source_label',
  'import_run.page_count as page_count',
  'import_run.started_by as started_by',
  'import_run.started_at as started_at',
  'import_run.finished_at as finished_at',
] as const;

function emptySummary(): ImportRunSummary {
  return { pages: 0, added: 0, updated: 0, unchanged: 0, removed: 0, restored: 0 };
}

// Counted off the ledger on every read. The summary column is a cache of this
// and nothing reads it back, so the two can never be seen disagreeing. One
// query for a whole timeline rather than one per run, which is what keeps a
// deck imported daily for three years to a single group by.
async function countsByRun(
  db: Connection,
  runIds: string[]
): Promise<Map<string, ImportRunSummary>> {
  const summaries = new Map(runIds.map((id) => [id, emptySummary()]));
  if (runIds.length === 0) return summaries;

  const rows = await db
    .selectFrom('import_run_card')
    .select((eb) => [
      'import_run_card.run_id as run_id',
      'import_run_card.outcome as outcome',
      eb.fn.countAll<string>().as('count'),
      sql<string>`count(*) filter (where import_run_card.restored)`.as('restored'),
    ])
    .where('import_run_card.run_id', 'in', runIds)
    .groupBy(['import_run_card.run_id', 'import_run_card.outcome'])
    .execute();

  for (const row of rows) {
    const summary = summaries.get(row.run_id);
    if (!summary) continue;
    const total = Number(row.count);
    if (row.outcome === 'added') summary.added += total;
    else if (row.outcome === 'updated') summary.updated += total;
    else if (row.outcome === 'unchanged') summary.unchanged += total;
    else if (row.outcome === 'removed') summary.removed += total;
    // A removed card carries no page: it is what the export stopped having.
    if (row.outcome !== 'removed') summary.pages += total;
    summary.restored += Number(row.restored);
  }
  return summaries;
}

export interface RunRow {
  id: string;
  import_id: string;
  status: string;
  source_label: string | null;
  page_count: number;
  started_by: string;
  started_at: Date | string;
  finished_at: Date | string | null;
}

export function serializeRun(row: RunRow, counts: ImportRunSummary): SerializedRun {
  return {
    id: row.id,
    import_id: row.import_id,
    status: row.status,
    source_label: row.source_label,
    page_count: row.page_count,
    started_by: row.started_by,
    started_at: new Date(row.started_at).toISOString(),
    finished_at: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
    counts,
  };
}

export async function runCounts(db: Connection, runId: string): Promise<ImportRunSummary> {
  return (await countsByRun(db, [runId])).get(runId) ?? emptySummary();
}

// A run read through the deck it belongs to. The scope is the import rather
// than the project: two decks of one project have separate histories, and a run
// of the wrong one is not this deck's to answer with.
export async function runInImport(
  db: Connection,
  importId: string,
  runId: string
): Promise<RunRow> {
  const row = await db
    .selectFrom('import_run')
    .select(RUN_COLUMNS)
    .where('import_run.id', '=', runId)
    .where('import_run.import_id', '=', importId)
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'Import run not found');
  return row;
}

export async function readRun(c: Ctx, runId: string): Promise<SerializedRun> {
  const db = c.get('db');
  const row = await db
    .selectFrom('import_run')
    .select(RUN_COLUMNS)
    .where('import_run.id', '=', runId)
    .executeTakeFirstOrThrow();
  return serializeRun(row, await runCounts(db, runId));
}

export async function readTimeline(c: Ctx, importId: string): Promise<SerializedRun[]> {
  const db = c.get('db');
  const rows = await db
    .selectFrom('import_run')
    .select(RUN_COLUMNS)
    .where('import_run.import_id', '=', importId)
    .orderBy('import_run.started_at', 'desc')
    .orderBy('import_run.id', 'desc')
    .execute();

  const counts = await countsByRun(
    db,
    rows.map((row) => row.id)
  );
  return rows.map((row) => serializeRun(row, counts.get(row.id) ?? emptySummary()));
}

export async function readRunDetail(c: Ctx, importId: string, runId: string): Promise<RunDetail> {
  const db = c.get('db');
  const run = serializeRun(await runInImport(db, importId, runId), await runCounts(db, runId));
  const cards = await db
    .selectFrom('import_run_card')
    .leftJoin('deck_import_card', 'deck_import_card.id', 'import_run_card.import_card_id')
    .select([
      'import_run_card.page_number as page_number',
      'import_run_card.outcome as outcome',
      'import_run_card.matched_by as matched_by',
      'import_run_card.restored as restored',
      'import_run_card.name as name',
      'import_run_card.file_version_number as file_version_number',
      'deck_import_card.file_id as file_id',
    ])
    .where('import_run_card.run_id', '=', runId)
    // Removed cards carry no page and sort after the pages that were posted.
    .orderBy('import_run_card.page_number', (ob) => ob.asc().nullsLast())
    .orderBy('import_run_card.id', 'asc')
    .execute();

  return { run, cards };
}
