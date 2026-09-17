import { sql } from 'kysely';
import { AppError } from '../../utils/errors.ts';
import type { Ctx } from './common.ts';
import { runCounts, runInImport, serializeRun, type SerializedRun } from './runs.ts';

// What the imports had put in a deck as of one run. A window over the ledger,
// which is not the deck itself: a card somebody added or removed by hand has no
// ledger row at all, and the screen has to say so rather than implying
// otherwise.

interface DeckAsOfCard {
  card_id: string;
  file_id: string;
  name: string;
  file_version_number: number | null;
  page_number: number | null;
  last_run_id: string;
  outcome: string;
  image_deleted_at: string | null;
}

// deleted_at arrives as a Date, and it is the one column here that is not
// already a string.
interface DeckAsOfRow extends Omit<DeckAsOfCard, 'image_deleted_at'> {
  image_deleted_at: Date | string | null;
}

export interface DeckAsOf {
  run: SerializedRun;
  cards: DeckAsOfCard[];
  has_purged_history: boolean;
}

// The window: every finished run of this import up to and including the anchor.
// Finishing is the only moment the deck changed, so it is the only kind of run
// "as it stood" can be asked about. (started_at, id) is the total order
// readTimeline sorts by, and import_run_timeline_idx covers it.
function scopeOfRun(runId: string) {
  return sql`
    anchor as (select import_id, started_at, id from import_run where id = ${runId}),
    in_scope as (
      select r.id, r.started_at
      from import_run r
      join anchor a on a.import_id = r.import_id
      where r.status = 'finished' and (r.started_at, r.id) <= (a.started_at, a.id)
    )`;
}

// What the imports had put in this deck once one run had finished: per card, the
// newest ledger row at or before it, minus the cards that run took away. It is
// not the deck -- a card somebody added or removed by hand has no ledger row at
// all -- and the screen has to say so rather than implying otherwise.
export async function readDeckAsOfRun(c: Ctx, importId: string, runId: string): Promise<DeckAsOf> {
  const db = c.get('db');
  const row = await runInImport(db, importId, runId);
  if (row.status === 'open') {
    throw new AppError(409, 'That import is still running. Finish it before asking what it left');
  }
  if (row.status !== 'finished') {
    throw new AppError(409, 'That import was abandoned. It handed the deck nothing');
  }

  const scope = scopeOfRun(runId);

  // Partitioned on import_card_id and nothing else. A purged card's rows have
  // lost it, and no column left on them correlates one run's row with the next,
  // so falling back on the ledger row's own id would turn one purged card into
  // a fresh card per run.
  const cards = await sql<DeckAsOfRow>`
    with ${scope},
    ranked as (
      select c.import_card_id, c.outcome, c.name, c.page_number, c.file_version_number,
             s.id as run_id,
             row_number() over (
               partition by c.import_card_id
               order by s.started_at desc, s.id desc, c.id desc
             ) as rn
      from import_run_card c
      join in_scope s on s.id = c.run_id
      where c.import_card_id is not null
    )
    select r.import_card_id as card_id, d.file_id, r.name, r.file_version_number,
           r.page_number, r.run_id as last_run_id, r.outcome,
           f.deleted_at as image_deleted_at
    from ranked r
    join deck_import_card d on d.id = r.import_card_id
    join file f on f.id = d.file_id
    where r.rn = 1 and r.outcome <> 'removed'
    order by r.page_number asc nulls last, r.name asc, r.import_card_id asc
  `.execute(db);

  const purged = await sql<{ any_purged: boolean }>`
    with ${scope}
    select exists (
      select 1 from import_run_card c join in_scope s on s.id = c.run_id
      where c.import_card_id is null
    ) as any_purged
  `.execute(db);

  return {
    run: serializeRun(row, await runCounts(db, runId)),
    cards: cards.rows.map((card) => ({
      ...card,
      image_deleted_at:
        card.image_deleted_at === null ? null : new Date(card.image_deleted_at).toISOString(),
    })),
    has_purged_history: purged.rows[0]?.any_purged ?? false,
  };
}
