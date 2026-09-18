import type { PrintReason } from '@three-peaks/shared';
import { AppError } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import type { AppContext, Connection } from '../types/index.ts';

// What a deck still owes the printer, and the ledger that answers it.
//
// One rule decides everything this file reports, and every reason a card is
// listed for is a consequence of it rather than a separate test:
//
//   owed = quantity - (copies already printed at this card's current artwork,
//                      with the reverse the deck currently gives it)
//
// A card nobody has printed has printed none of it; a card whose artwork was
// re-imported has none at the new version; a card whose deck was given a new
// back has none with that back on it; and a card whose copy count went up has
// some but not enough. Four situations, one subtraction -- which is what keeps
// the number on the screen and the cards on the sheet from disagreeing.
//
// Copies accumulate across runs deliberately. Printing the two a deck is short
// and then asking again has to say zero, or every partial run would ask for the
// same shortfall for ever.

interface CardRow {
  deck_id: string;
  file_id: string;
  quantity: number;
}

// One group of runs that put the same artwork on paper behind the same reverse.
// Grouped in the database rather than read row by row: a deck printed weekly
// for a year is fifty rows per card, and all any of them are asked is how many
// copies of which version.
interface PrintedGroup {
  file_id: string;
  version_number: number;
  back_file_id: string | null;
  back_version_number: number | null;
  copies: number;
  printed_at: Date | string;
}

interface OutstandingCard {
  file_id: string;
  version_number: number;
  quantity: number;
  printed_copies: number;
  owed_copies: number;
  printed_version_number: number | null;
  last_printed_at: string | null;
  reason: PrintReason | null;
}

export interface OutstandingDeck {
  deck_id: string;
  back_file_id: string | null;
  back_version_number: number | null;
  last_printed_at: string | null;
  cards: OutstandingCard[];
}

// A file with no version rows at all was uploaded before that table existed;
// every read path presents its mirror as version 1, and so does this one.
const FIRST_VERSION = 1;

// Every card file and every back in the project, with the number the newest
// version carries. Scoped by project rather than by a list of ids: a deck of
// five hundred cards would otherwise be five hundred parameters, and a file
// owned by a deck is exactly the set this needs.
async function currentVersions(db: Connection, projectId: string): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom('file_version')
    .innerJoin('file', 'file.id', 'file_version.file_id')
    .select((eb) => [
      'file_version.file_id as file_id',
      eb.fn.max<number>('file_version.version_number').as('version_number'),
    ])
    .where('file.project_id', '=', projectId)
    .where('file.deck_id', 'is not', null)
    .groupBy('file_version.file_id')
    .execute();

  return new Map(rows.map((row) => [row.file_id, Number(row.version_number)]));
}

async function printedGroups(
  db: Connection,
  projectId: string
): Promise<Map<string, PrintedGroup[]>> {
  const rows = await db
    .selectFrom('print_run_card')
    .innerJoin('print_run', 'print_run.id', 'print_run_card.run_id')
    .innerJoin('file', 'file.id', 'print_run_card.file_id')
    .select((eb) => [
      'print_run_card.file_id as file_id',
      'print_run_card.version_number as version_number',
      'print_run_card.back_file_id as back_file_id',
      'print_run_card.back_version_number as back_version_number',
      eb.fn.sum<string>('print_run_card.copies').as('copies'),
      eb.fn.max<Date>('print_run.created_at').as('printed_at'),
    ])
    .where('file.project_id', '=', projectId)
    .groupBy([
      'print_run_card.file_id',
      'print_run_card.version_number',
      'print_run_card.back_file_id',
      'print_run_card.back_version_number',
    ])
    .execute();

  const grouped = new Map<string, PrintedGroup[]>();
  for (const row of rows) {
    const group: PrintedGroup = {
      file_id: row.file_id,
      version_number: row.version_number,
      back_file_id: row.back_file_id,
      back_version_number: row.back_version_number,
      copies: Number(row.copies),
      printed_at: row.printed_at,
    };
    const held = grouped.get(row.file_id);
    if (held) held.push(group);
    else grouped.set(row.file_id, [group]);
  }
  return grouped;
}

// Two ways a reverse cannot be out of date, and both are a match rather than a
// mismatch. A deck with no back puts nothing on the reverse to begin with --
// which is also what stops purging a back, since that nulls the pointer on the
// deck and on the ledger alike, from asking for the whole deck again. And a run
// that left the backing pages out printed no reverse at all, so a later change
// of back says nothing about the cards it produced: without this, somebody who
// prints fronts onto pre-backed stock would be told every card is owed for ever.
function backMatches(
  group: PrintedGroup,
  backFileId: string | null,
  backVersion: number | null
): boolean {
  if (backFileId === null || group.back_file_id === null) return true;
  return group.back_file_id === backFileId && group.back_version_number === backVersion;
}

function outstandingCard(
  card: CardRow,
  version: number,
  backFileId: string | null,
  backVersion: number | null,
  groups: readonly PrintedGroup[]
): OutstandingCard {
  const atVersion = groups.filter((group) => group.version_number === version);
  const matching = atVersion.filter((group) => backMatches(group, backFileId, backVersion));
  const printed = matching.reduce((total, group) => total + group.copies, 0);
  const owed = Math.max(0, card.quantity - printed);

  const printedVersion = groups.reduce<number | null>(
    (highest, group) =>
      highest === null ? group.version_number : Math.max(highest, group.version_number),
    null
  );
  const lastPrinted = groups.reduce<number | null>((latest, group) => {
    const at = new Date(group.printed_at).getTime();
    return latest === null ? at : Math.max(latest, at);
  }, null);

  // Ordered from the least recoverable outward: no print at all, then the wrong
  // artwork, then the right artwork behind the wrong back, then simply not
  // enough of it.
  const reason: PrintReason | null =
    owed === 0
      ? null
      : printedVersion === null
        ? 'never'
        : atVersion.length === 0
          ? 'artwork'
          : matching.length === 0
            ? 'back'
            : 'copies';

  return {
    file_id: card.file_id,
    version_number: version,
    quantity: card.quantity,
    printed_copies: printed,
    owed_copies: owed,
    printed_version_number: printedVersion,
    last_printed_at: lastPrinted === null ? null : new Date(lastPrinted).toISOString(),
    reason,
  };
}

/**
 * Every live card of every live deck in a project, with what it still owes.
 *
 * Deleted cards and deleted decks are left out rather than reported as up to
 * date: a tombstone has no bytes to put on paper, and the print screen does not
 * list one.
 */
export async function readOutstanding(
  c: Pick<AppContext, 'get'>,
  projectId: string
): Promise<OutstandingDeck[]> {
  const db = c.get('db');

  const decks = await db
    .selectFrom('deck')
    .select(['deck.id as id', 'deck.back_file_id as back_file_id'])
    .where('deck.project_id', '=', projectId)
    .where('deck.deleted_at', 'is', null)
    .orderBy('deck.name', 'asc')
    .execute();
  if (decks.length === 0) return [];

  const [cards, versions, printed] = await Promise.all([
    db
      .selectFrom('deck_card')
      .innerJoin('deck', 'deck.id', 'deck_card.deck_id')
      .innerJoin('file', 'file.id', 'deck_card.file_id')
      .select([
        'deck_card.deck_id as deck_id',
        'deck_card.file_id as file_id',
        'deck_card.quantity as quantity',
      ])
      .where('deck.project_id', '=', projectId)
      .where('deck.deleted_at', 'is', null)
      .where('file.deleted_at', 'is', null)
      .orderBy('deck_card.position', 'asc')
      .orderBy('deck_card.id', 'asc')
      .execute(),
    currentVersions(db, projectId),
    printedGroups(db, projectId),
  ]);

  const byDeck = new Map<string, CardRow[]>();
  for (const card of cards) {
    const held = byDeck.get(card.deck_id);
    if (held) held.push(card);
    else byDeck.set(card.deck_id, [card]);
  }

  return decks.map((deck) => {
    const backVersion =
      deck.back_file_id === null ? null : (versions.get(deck.back_file_id) ?? FIRST_VERSION);

    const rows = (byDeck.get(deck.id) ?? []).map((card) =>
      outstandingCard(
        card,
        versions.get(card.file_id) ?? FIRST_VERSION,
        deck.back_file_id,
        backVersion,
        printed.get(card.file_id) ?? []
      )
    );

    const lastPrinted = rows.reduce<string | null>((latest, row) => {
      if (row.last_printed_at === null) return latest;
      return latest === null || row.last_printed_at > latest ? row.last_printed_at : latest;
    }, null);

    return {
      deck_id: deck.id,
      back_file_id: deck.back_file_id,
      back_version_number: backVersion,
      last_printed_at: lastPrinted,
      cards: rows,
    };
  });
}

export interface PrintRunCardInput {
  file_id: string;
  version_number: number;
  copies: number;
  back_file_id?: string | null;
  back_version_number?: number | null;
}

export interface SerializedPrintRun {
  id: string;
  project_id: string;
  created_by: string | null;
  created_at: string;
  card_count: number;
  copies: number;
}

// Everything a run may name, read once. A version number that does not exist
// yet is the interesting refusal: it is what a client that computed one rather
// than reading it back would send, and recording it would leave every card in
// the run permanently ahead of its own file.
async function assertPrintable(
  db: Connection,
  projectId: string,
  cards: readonly PrintRunCardInput[]
): Promise<void> {
  const fileIds = cards.map((card) => card.file_id);
  if (new Set(fileIds).size !== fileIds.length) {
    throw new AppError(422, 'A card can only be recorded once in a print run');
  }

  const versions = await currentVersions(db, projectId);
  const owned = await db
    .selectFrom('file')
    .select(['file.id as id'])
    .where('file.project_id', '=', projectId)
    .where('file.deck_id', 'is not', null)
    .where('file.deleted_at', 'is', null)
    .where('file.id', 'in', [
      ...new Set([
        ...fileIds,
        ...cards.flatMap((card) => (card.back_file_id ? [card.back_file_id] : [])),
      ]),
    ])
    .execute();
  const live = new Set(owned.map((row) => row.id));

  const known = (fileId: string, number: number) =>
    live.has(fileId) && number <= (versions.get(fileId) ?? FIRST_VERSION);

  for (const card of cards) {
    if (!known(card.file_id, card.version_number)) {
      throw new AppError(
        422,
        'Every card in a print run has to be a live card of a deck in this project, at a version it actually has'
      );
    }
    if (
      card.back_file_id != null &&
      !known(card.back_file_id, card.back_version_number ?? FIRST_VERSION)
    ) {
      throw new AppError(
        422,
        'The back a card was printed with has to be a live image of a deck in this project, at a version it actually has'
      );
    }
  }
}

/**
 * Writes down what came off the printer.
 *
 * The version numbers come from the client because the client is the only end
 * that knows which bytes it drew -- it fetches each card at the version the
 * outstanding read named, so the ledger records the artwork on the paper rather
 * than whatever the file happened to reach while the document was building.
 */
export async function recordRun(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  input: { id?: string; cards: readonly PrintRunCardInput[] }
): Promise<SerializedPrintRun> {
  const db = c.get('db');
  await assertPrintable(db, projectId, input.cards);

  const run = await db
    .insertInto('print_run')
    .values({
      id: input.id ?? newId(),
      project_id: projectId,
      created_by: c.get('user').id,
    })
    .returning([
      'print_run.id as id',
      'print_run.project_id as project_id',
      'print_run.created_by as created_by',
      'print_run.created_at as created_at',
    ])
    .executeTakeFirstOrThrow();

  await db
    .insertInto('print_run_card')
    .values(
      input.cards.map((card) => ({
        id: newId(),
        run_id: run.id,
        file_id: card.file_id,
        version_number: card.version_number,
        copies: card.copies,
        back_file_id: card.back_file_id ?? null,
        back_version_number: card.back_file_id == null ? null : (card.back_version_number ?? null),
      }))
    )
    .execute();

  return {
    id: run.id,
    project_id: run.project_id,
    created_by: run.created_by,
    created_at: new Date(run.created_at).toISOString(),
    card_count: input.cards.length,
    copies: input.cards.reduce((total, card) => total + card.copies, 0),
  };
}

// Undoing a run removes it rather than tombstoning it. A run is a claim that
// certain cards are on paper; a claim withdrawn was never true, and leaving a
// false one in the ledger under a flag would mean every read of it carrying the
// flag for ever.
export async function deleteRun(db: Connection, runId: string): Promise<void> {
  await db.deleteFrom('print_run').where('print_run.id', '=', runId).execute();
}
