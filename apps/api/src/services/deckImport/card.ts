import { MAX_DECK_CARDS } from '@three-peaks/shared';
import { AppError, isUniqueViolation } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import { freeFilename, type StoredUpload } from '../files.ts';
import { countDeckCards, ensureDeckCard } from '../decks.ts';
import { type FileHome, homeColumns } from '../fileHome.ts';
import { cardCapError, type Ctx } from './common.ts';
import type { Connection } from '../../types/index.ts';

// The card row an imported page lands on: creating it, giving it a place in the
// deck, and deciding what it is called. Nothing here reads a request or moves
// any bytes -- `page.ts` does both and calls in here once it has an image.

// Every file this import writes lands in the deck, so the home is the deck's
// and nothing else here has to decide it.
export function deckHome(deckId: string): FileHome {
  return { kind: 'deck', deckId };
}

export interface OpenRun {
  runId: string;
  importId: string;
  deckId: string;
  projectId: string;
}

export interface CardFile {
  id: string;
  project_id: string;
  filename: string;
  name_locked: boolean;
  deleted_at: Date | string | null;
}

const CARD_FILE_COLUMNS = [
  'file.id as id',
  'file.project_id as project_id',
  'file.filename as filename',
  'file.name_locked as name_locked',
  'file.deleted_at as deleted_at',
] as const;

// What the import puts in the copies column of a row it is creating. A back is
// not a face and prints none of itself: the page an export titles Back, and a
// file this deck already points at as its back -- which is a back that has no
// card row at all, and handing that one a copy would print the back on the
// front of a sheet.
async function copiesForNewCard(
  db: Connection,
  deckId: string,
  fileId: string,
  isBack: boolean
): Promise<number> {
  if (isBack) return 0;
  const deck = await db
    .selectFrom('deck')
    .select(['deck.back_file_id as back_file_id'])
    .where('deck.id', '=', deckId)
    .executeTakeFirst();
  return deck?.back_file_id === fileId ? 0 : 1;
}

// Idempotent in both halves: a page re-imported onto a card the deck already
// holds must not add a second row, and a card restored after a finish took it
// out needs its place back.
//
// A page titled Back is the deck's back, and this is where that takes effect --
// the moment its bytes land, beside the row saying where the artwork sits, for
// the reason the caller gives for placing it here at all. The copy count is
// forced to zero even on a row that already existed, which is the one place the
// import overrules a count somebody could have typed: a back has no faces to
// print, so there is no count there to preserve. It is also what lets this
// reach a deck imported before any of it existed, where the back is sitting in
// the run as an ordinary card at one copy.
//
// Two pages of one export titled Back is a mistake rather than a deck with two
// backs. Both become zero-copy cards and the last to land is the one the deck
// points at.
export async function placeCardInDeck(
  db: Connection,
  deckId: string,
  cardId: string,
  fileId: string,
  isBack: boolean
): Promise<void> {
  const existing = await db
    .selectFrom('deck_card')
    .select(['deck_card.id as id', 'deck_card.quantity as quantity'])
    .where('deck_card.deck_id', '=', deckId)
    .where('deck_card.file_id', '=', fileId)
    .executeTakeFirst();

  if (!existing) {
    // Checked here as well as at run start, because a hand edit can take the
    // last free place while the run is open. The page is the right thing to
    // refuse: a deck past the cap is one the deck editor can never save again,
    // and finding that out at finish costs the whole upload.
    const held = await countDeckCards(db, deckId);
    if (held + 1 > MAX_DECK_CARDS) throw cardCapError(held + 1);

    await ensureDeckCard(db, deckId, fileId, await copiesForNewCard(db, deckId, fileId, isBack));
  } else if (isBack && existing.quantity !== 0) {
    await db
      .updateTable('deck_card')
      .set({ quantity: 0 })
      .where('deck_card.id', '=', existing.id)
      .execute();
  }

  if (isBack) {
    await db
      .updateTable('deck')
      .set({ back_file_id: fileId, updated_at: new Date() })
      .where('deck.id', '=', deckId)
      .execute();
  }

  await db
    .updateTable('deck_import_card')
    .set({ added_to_deck_at: new Date() })
    .where('deck_import_card.id', '=', cardId)
    .where('deck_import_card.added_to_deck_at', 'is', null)
    .execute();
}

// A name a person typed is not this import's to overwrite.
export function nameForCard(file: CardFile, derived: string): string {
  if (file.name_locked) return file.filename;
  return derived;
}

// The card the plan named, if it is there yet. It may not be: the plan calls a
// page new precisely when no row answers to it, and a purge during the run can
// take one away. Either way the page inserts the row under the planned id.
//
// Deliberately not filtered by file.deleted_at. Finding the tombstone is what
// makes a card that came back a restore rather than a second card.
export async function lockPlannedCard(
  db: Connection,
  cardId: string
): Promise<CardFile | undefined> {
  return await db
    .selectFrom('deck_import_card')
    .innerJoin('file', 'file.id', 'deck_import_card.file_id')
    .select(CARD_FILE_COLUMNS)
    .where('deck_import_card.id', '=', cardId)
    .forUpdate('file')
    .executeTakeFirst();
}

interface NewCard {
  cardId: string;
  identityKey: string;
  sourcePageId: string | null;
  pageNumber: number;
  derivedName: string;
  stored: StoredUpload;
}

// The key the new mapping row can take right now, which is not always the one
// it ends with: the plan deconflicted against the mapping as it will stand once
// the run has finished, and until then a card the plan claimed still holds the
// key it had. Decided by a select rather than by catching the violation, which
// would leave the transaction aborted with the whole page still to write. `p:`
// is derived from the row's own id, so it terminates rather than colliding
// again, and finish rewrites it to whatever the plan intended.
async function resolveInsertKey(
  db: Connection,
  importId: string,
  identityKey: string,
  cardId: string
): Promise<string> {
  const held = await db
    .selectFrom('deck_import_card')
    .select(['deck_import_card.id as id'])
    .where('deck_import_card.import_id', '=', importId)
    .where('deck_import_card.detached_at', 'is', null)
    .where('deck_import_card.identity_key', '=', identityKey)
    .executeTakeFirst();
  return held ? `p:${cardId}` : identityKey;
}

export async function createCard(c: Ctx, run: OpenRun, card: NewCard): Promise<CardFile> {
  const db = c.get('db');
  const filename = await freeFilename(db, run.projectId, deckHome(run.deckId), card.derivedName);
  const identityKey = await resolveInsertKey(db, run.importId, card.identityKey, card.cardId);

  let file: CardFile;
  try {
    file = await db
      .insertInto('file')
      .values({
        id: newId(),
        project_id: run.projectId,
        ...homeColumns(deckHome(run.deckId)),
        filename,
        // The key appendFileVersion is about to be handed, so it recognises the
        // row as one just inserted rather than adopting a mirror as version 1.
        storage_key: card.stored.storageKey,
        content_type: card.stored.contentType,
        byte_size: String(card.stored.byteSize),
        checksum: card.stored.checksum,
        uploaded_by: c.get('user').id,
      })
      .returning(CARD_FILE_COLUMNS)
      .executeTakeFirstOrThrow();
  } catch (error) {
    // Its own catch: the mapping insert that follows cannot produce a name conflict,
    // and calling one of its violations that would be a lie.
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'A file with that name already exists here');
    }
    throw error;
  }

  // No catch. Both indexes here are ruled out before the write -- the key by
  // resolveInsertKey, the file by its being one row old.
  await db
    .insertInto('deck_import_card')
    .values({
      id: card.cardId,
      import_id: run.importId,
      file_id: file.id,
      identity_key: identityKey,
      // Straight in, where the key next to it had to be deconflicted first. The
      // page-id tier runs before the others and takes whatever card already
      // holds an id, so a page the plan calls new is one no live card can be
      // contending with for it.
      source_page_id: card.sourcePageId,
      page_number: card.pageNumber,
    })
    .execute();

  return file;
}

// The name the card ends the page with. A taken name is not worth refusing a
// page over -- the card is identified by its mapping row, not by what it is
// called -- so the old one stays and nothing is said about it.
//
// An untitled page never renames anything: its key is its page number, so every
// card in a reordered untitled deck would be reaching for a name another live
// card still holds.
export async function renamedTo(
  db: Connection,
  run: OpenRun,
  file: CardFile,
  title: string | null,
  derivedName: string
): Promise<string> {
  if (title === null || title.trim().length === 0) return file.filename;
  const wanted = nameForCard(file, derivedName);
  if (wanted === file.filename) return file.filename;
  const free = await freeFilename(db, run.projectId, deckHome(run.deckId), wanted);
  return free === wanted ? wanted : file.filename;
}

// --- finishing --------------------------------------------------------------
