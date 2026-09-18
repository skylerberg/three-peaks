import { type ExpressionBuilder, sql } from 'kysely';
import { MAX_DECK_CARDS } from '@three-peaks/shared';
import type { DB } from '../db/types.ts';
import { AppError } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { FILE_COLUMNS, serializeFile } from './files.ts';
import type { AppContext, Connection } from '../types/index.ts';

// One reader for a deck and one for its cards, in a service rather than in the
// deck routes: the import finishes a run by rewriting a deck's contents, and an
// event announcing that has to carry the same rows the deck routes answer with.

interface DeckRow {
  id: string;
  project_id: string;
  name: string;
  // numeric comes back from pg as a string, the way bigint does.
  card_width_mm: string | number;
  card_height_mm: string | number;
  back_file_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  card_count: string | number | null;
  total_copies: string | number | null;
}

const DECK_COLUMNS = [
  'deck.id as id',
  'deck.project_id as project_id',
  'deck.name as name',
  'deck.card_width_mm as card_width_mm',
  'deck.card_height_mm as card_height_mm',
  'deck.back_file_id as back_file_id',
  'deck.created_by as created_by',
  'deck.created_at as created_at',
  'deck.updated_at as updated_at',
  'deck.deleted_at as deleted_at',
] as const;

export function serializeDeck(row: DeckRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    card_width_mm: Number(row.card_width_mm),
    card_height_mm: Number(row.card_height_mm),
    back_file_id: row.back_file_id,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    deleted_at: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
    card_count: Number(row.card_count ?? 0),
    total_copies: Number(row.total_copies ?? 0),
  };
}

// The two totals every deck is listed with, as a correlated subquery each rather
// than a join: a join to deck_card would multiply the deck rows and both numbers
// would then have to be undone with a group by.
//
// Only live cards count. A deleted card keeps its row so a restore is exact,
// but it prints nothing, and a total that included it would disagree with
// every sheet the deck produces. The cap is the other question -- how many
// rows a deck holds -- and `countDeckCards` answers it with the tombstones in.
export function withCounts(db: Connection) {
  const liveCards = (eb: ExpressionBuilder<DB, 'deck'>) =>
    eb
      .selectFrom('deck_card')
      .innerJoin('file', 'file.id', 'deck_card.file_id')
      .whereRef('deck_card.deck_id', '=', 'deck.id')
      .where('file.deleted_at', 'is', null);

  return db.selectFrom('deck').select((eb) => [
    ...DECK_COLUMNS,
    liveCards(eb)
      .select((inner) => inner.fn.countAll<string>().as('count'))
      .as('card_count'),
    liveCards(eb)
      .select((inner) => inner.fn.sum<string>('deck_card.quantity').as('total'))
      .as('total_copies'),
  ]);
}

export async function readDeck(c: Pick<AppContext, 'get'>, deckId: string) {
  const row = await withCounts(c.get('db')).where('deck.id', '=', deckId).executeTakeFirst();
  if (!row) throw new AppError(404, 'Deck not found');
  return serializeDeck(row);
}

export async function readDeckCards(c: Pick<AppContext, 'get'>, deckId: string) {
  const rows = await c
    .get('db')
    .selectFrom('deck_card')
    .innerJoin('file', 'file.id', 'deck_card.file_id')
    // The same columns and the same serializer every other read of a file uses.
    // Building the embedded object by hand here is what left name_locked off it
    // while the schema went on declaring it.
    .select(['deck_card.quantity as quantity', 'deck_card.position as position', ...FILE_COLUMNS])
    .where('deck_card.deck_id', '=', deckId)
    // id breaks the tie, so a listing is stable rather than whatever order the
    // planner happened to return equal positions in.
    .orderBy('deck_card.position', 'asc')
    .orderBy('deck_card.id', 'asc')
    .execute();

  return rows.map((row) => ({
    file_id: row.id,
    quantity: row.quantity,
    position: row.position,
    file: serializeFile(row),
  }));
}

export async function countDeckCards(db: Connection, deckId: string): Promise<number> {
  const row = await db
    .selectFrom('deck_card')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('deck_card.deck_id', '=', deckId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Gives one of a deck's images a place in its arrangement, at the end, and says
 * whether it had to. Every arrival at a single `deck_card` row comes through
 * here -- an upload, a move in, an import page and a restore -- because the
 * rule all four are keeping is the same one, that a deck's live artwork is
 * always somewhere in its own list.
 *
 * Idempotent, because two of the four arrive at a row that may already be
 * there. A card deleted by hand kept its row and its copy count, and a restore
 * taking a second one would raise a unique violation and lose the place the
 * person is expecting back. The cap belongs to the caller: what to say when a
 * deck is full depends on what it was being asked to do.
 *
 * `copies` is what a row this creates is given, and only the import passes it:
 * the back of a deck is in the arrangement and prints none of itself. A row
 * that was already there keeps whatever count it has, whoever is calling --
 * what to do about one is the caller's, the same way the cap is.
 */
export async function ensureDeckCard(
  db: Connection,
  deckId: string,
  fileId: string,
  copies = 1
): Promise<boolean> {
  const inserted = await db
    .insertInto('deck_card')
    .values({
      id: newId(),
      deck_id: deckId,
      file_id: fileId,
      quantity: copies,
      position: await nextDeckPosition(db, deckId),
    })
    .onConflict((oc) => oc.columns(['deck_id', 'file_id']).doNothing())
    .returning(['deck_card.id as id'])
    .executeTakeFirst();

  return inserted !== undefined;
}

/**
 * The number a card arriving now would take: one past the end of the list.
 *
 * Here rather than inline because two callers need it -- this file, for a
 * single arrival, and the import, which adds its leftovers in one statement --
 * and a second copy of the query is a second answer to where the end of a deck
 * is, free to drift from this one.
 */
export async function nextDeckPosition(db: Connection, deckId: string): Promise<number> {
  const top = await db
    .selectFrom('deck_card')
    .select((eb) => eb.fn.max('deck_card.position').as('position'))
    .where('deck_card.deck_id', '=', deckId)
    .executeTakeFirst();
  return (top?.position ?? -1) + 1;
}

/**
 * Writes a deck's arrangement: the rows named, in the order named, numbered
 * from zero.
 *
 * This is the rule and not the policy. Which order a deck should be in is the
 * caller's to decide -- an import takes it from the design it was given -- and
 * what is fixed here is that the numbers come out dense and zero-based, and
 * that the caller names *every* row the deck holds. A position is an index into
 * one list, so renumbering part of it leaves two rows on one number and
 * `readDeckCards`' tie-break choosing between them.
 *
 * Two properties worth keeping if this is ever rewritten. Only the rows that
 * moved are written, so an arrangement that already agrees costs one statement
 * and no rows. And `position` is the only column touched: inserting a
 * `deck_card` row, or updating its `file_id`, takes a key share on the file it
 * names, and a deck rewritten by hand takes those *after* having rewritten
 * `deck_card` -- which is the deadlock the import's own file locks are ordered
 * around. A position carries no foreign key, so this stays out of it.
 */
export async function renumberDeckCards(
  db: Connection,
  ordered: readonly { id: string; position: number }[]
): Promise<void> {
  const moved = ordered
    .map((row, position) => ({ id: row.id, was: row.position, position }))
    .filter((row) => row.was !== row.position);
  if (moved.length === 0) return;

  await sql`
    update deck_card set position = place.position
    from (values ${sql.join(
      moved.map((row) => sql`(${row.id}::uuid, ${row.position}::int)`)
    )}) as place(id, position)
    where deck_card.id = place.id
  `.execute(db);
}

/**
 * Refuses to put a card back into a deck that has no room for it. A file that
 * still holds its place needs none, so restoring one a person deleted by hand
 * is never refused.
 *
 * The cap is what the deck editor validates a saved list against, so a deck
 * pushed past it is one no hand edit can save again. Refusing the restore is
 * the one moment a person can still choose otherwise.
 */
export async function assertRoomForCard(
  db: Connection,
  deckId: string,
  fileId: string
): Promise<void> {
  const held = await db
    .selectFrom('deck_card')
    .select(['deck_card.id as id'])
    .where('deck_card.deck_id', '=', deckId)
    .where('deck_card.file_id', '=', fileId)
    .executeTakeFirst();
  if (held) return;

  const total = await countDeckCards(db, deckId);
  if (total >= MAX_DECK_CARDS) {
    throw new AppError(
      422,
      `That deck already holds ${MAX_DECK_CARDS} cards, which is as many as a deck holds. Take one out of it first.`,
      { cards: total, limit: MAX_DECK_CARDS }
    );
  }
}

/**
 * Refuses a card list that is not exactly the deck's own artwork, bar a back
 * image that is not itself a card.
 *
 * Both halves matter. A file the deck does not own would be a card that Assets
 * still lists, which is the duplication owning artwork exists to remove; and a
 * live one left out would be artwork in the deck that no list names, which is a
 * third place for an image to be and the one state this arrangement has none
 * of. Removing a card means deleting it or moving it to Assets, and the message
 * says so, because there is no other way to say it from here.
 *
 * The two halves read different sets, deliberately. What may be named is
 * anything the deck owns, tombstone or not: deleting a card keeps its
 * `deck_card` row so a restore lands back where it was, the deck answers with
 * that row, and the list sent back is the list that was read -- refusing it
 * left a deck holding one deleted card unable to change any card's copies at
 * all. What must be named is only the live artwork, because an import takes a
 * card out of the arrangement as it tombstones it, and demanding the row it
 * deleted would jam the same editor from the other side.
 */
export async function assertCardFiles(
  c: Pick<AppContext, 'get'>,
  deckId: string,
  fileIds: readonly string[]
): Promise<void> {
  const db = c.get('db');
  const deck = await db
    .selectFrom('deck')
    .select(['deck.back_file_id as back_file_id'])
    .where('deck.id', '=', deckId)
    .executeTakeFirstOrThrow();

  const owned = await db
    .selectFrom('file')
    .select(['file.id as id', 'file.filename as filename', 'file.deleted_at as deleted_at'])
    .where('file.deck_id', '=', deckId)
    .orderBy('file.filename', 'asc')
    .execute();

  const ownedIds = new Set(owned.map((row) => row.id));
  const given = new Set(fileIds);

  for (const id of given) {
    if (!ownedIds.has(id)) {
      throw new AppError(
        422,
        'Every card has to be an image this deck holds. Upload it here, or move it in from Assets.'
      );
    }
  }

  const stranded = owned.filter(
    (row) => row.deleted_at === null && !given.has(row.id) && row.id !== deck.back_file_id
  );
  if (stranded.length > 0) {
    const rest = stranded.length === 1 ? '' : ` and ${stranded.length - 1} more`;
    throw new AppError(
      422,
      `"${stranded[0].filename}"${rest} would be left in this deck with no place in it. Delete it, or move it to Assets.`
    );
  }
}
