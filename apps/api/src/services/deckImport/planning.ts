import { MAX_DECK_CARDS, deckIdentityKey, isDeckBackTitle } from '@three-peaks/shared';
import { sql } from 'kysely';
import { AppError } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import { countDeckCards } from '../decks.ts';
import { cardCapError } from './common.ts';
import type { SerializedRun } from './runs.ts';
import type { Connection } from '../../types/index.ts';

// Which page becomes which card, decided once before any bytes exist.
//
// This module works it out and says what it would do; `start.ts` is what writes
// the answer down. Everything here is a read and a computation -- which is what
// lets the confirmation step in Canva ask the question without committing to
// it.

export interface StartRunPage {
  pageNumber: number;
  title: string | null;
  // The page's own id in the design it came from.
  pageId: string;
}

export interface StartRunInput {
  id?: string;
  sourceLabel: string | null;
  pages: StartRunPage[];
}

interface RunPlanPage {
  page_number: number;
  title: string | null;
  action: 'add' | 'update';
  matched_by: string | null;
  name: string | null;
  is_back: boolean;
}

// Named, not counted: the confirmation step exists to say which artwork a
// re-import is about to tombstone, and a bare number cannot.
interface RunPlanRemoval {
  file_id: string;
  name: string;
}

export interface RunPlan {
  added: number;
  updated: number;
  removed: RunPlanRemoval[];
  pages: RunPlanPage[];
}

export interface StartedRun extends SerializedRun {
  plan: RunPlan;
}

// One card as the mapping holds it when a run starts. `file_live` rather than a
// timestamp because the only question asked of it is whether the card is a
// tombstone -- and a tombstone is what a returning card is found as.
export interface MappingRow {
  card_id: string;
  file_id: string;
  filename: string;
  identity_key: string;
  source_page_id: string | null;
  page_number: number;
  added_to_deck_at: Date | string | null;
  file_live: boolean;
}

export interface PlannedPage {
  pageNumber: number;
  title: string | null;
  cardId: string;
  matchedBy: 'page_id' | 'identity' | 'page_number' | null;
  identityKey: string;
  sourcePageId: string | null;
  name: string | null;
}

// Numbered 1..n, each exactly once. That is what an export is, and it is what
// lets finishing compare a count against the manifest rather than enumerate
// which pages did and did not land.
export function orderedManifest(pages: StartRunPage[]): StartRunPage[] {
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const pageIds = new Set<string>();
  for (const [index, page] of sorted.entries()) {
    if (page.pageNumber !== index + 1) {
      throw new AppError(422, `An export's pages are numbered 1 to ${sorted.length}, each once`);
    }
    // A design's page ids are unique within it, and the whole of the strongest
    // tier rests on that. Two pages claiming one id would have them contend for
    // a card the way two titles do -- which the tier has no tie-break for,
    // because it was built on there never being one.
    if (pageIds.has(page.pageId)) {
      throw new AppError(422, "An export's pages each have their own page id");
    }
    pageIds.add(page.pageId);
  }
  return sorted;
}

export async function readLiveMapping(
  db: Connection,
  importId: string,
  deckId: string
): Promise<MappingRow[]> {
  return await db
    .selectFrom('deck_import_card')
    .innerJoin('file', 'file.id', 'deck_import_card.file_id')
    .select([
      'deck_import_card.id as card_id',
      'deck_import_card.file_id as file_id',
      'file.filename as filename',
      'deck_import_card.identity_key as identity_key',
      'deck_import_card.source_page_id as source_page_id',
      'deck_import_card.page_number as page_number',
      'deck_import_card.added_to_deck_at as added_to_deck_at',
      sql<boolean>`file.deleted_at is null`.as('file_live'),
    ])
    .where('deck_import_card.import_id', '=', importId)
    .where('deck_import_card.detached_at', 'is', null)
    .where('file.deck_id', '=', deckId)
    // The order the page-number probe reads its candidates in, and every part
    // of it is total: a live card before a tombstoned one, because restoring a
    // tombstone while a live card still sits at that number is the worse
    // mistake; then the card that has held the position longest; then the id.
    .orderBy(sql<boolean>`file.deleted_at is null`, 'desc')
    .orderBy('deck_import_card.created_at', 'asc')
    .orderBy('deck_import_card.id', 'asc')
    .execute();
}

/**
 * Assigns every page of an export to a card, in three passes over the manifest.
 *
 * A page's own id settles first, then its title, and only then does what is
 * left probe by page number. One interleaved walk would let an earlier page's
 * weaker claim take the card a later page names outright -- an export with a
 * page slid into the middle of it moves every title down one, so the weaker
 * claim would win on nothing but being walked first. That argument is why the
 * passes were separated in the first place, and it applies once more with a
 * third tier above the other two.
 *
 * All three go in page order, so two pages of one export sharing a title settle
 * the same way every time: the lower-numbered one keeps the card, and the other
 * falls to the page number and then to a card that does not exist yet, rather
 * than the export being refused. Page ids cannot contend like that -- they are
 * unique within the design they came from.
 *
 * A page carries its id onto whatever card it matched, by whichever tier, and
 * leaves the card's title key exactly where it was. That is what keeps the
 * second tier alive: a page duplicated in Canva mints a new id and keeps the
 * title, so the copy is placed by a title the id cannot speak for.
 */
export function planPages(pages: StartRunPage[], mapping: MappingRow[]): PlannedPage[] {
  const byIdentity = new Map<string, MappingRow>();
  const byPage = new Map<number, MappingRow[]>();
  for (const row of mapping) {
    if (!byIdentity.has(row.identity_key)) byIdentity.set(row.identity_key, row);
    const bucket = byPage.get(row.page_number);
    if (bucket) bucket.push(row);
    else byPage.set(row.page_number, [row]);
  }

  // A card written before the id was recorded has none, and null is not a key
  // any page can name -- so it is left out rather than bucketed under one.
  const byPageId = new Map<string, MappingRow>();
  for (const row of mapping) {
    if (row.source_page_id !== null && !byPageId.has(row.source_page_id)) {
      byPageId.set(row.source_page_id, row);
    }
  }

  const claimed = new Set<string>();
  const matches = new Map<number, { row: MappingRow; matchedBy: PlannedPage['matchedBy'] }>();
  const keys = pages.map((page) => deckIdentityKey(page.pageNumber, page.title));

  const claim = (
    index: number,
    row: MappingRow | undefined,
    matchedBy: PlannedPage['matchedBy']
  ): void => {
    if (matches.has(index) || !row || claimed.has(row.card_id)) return;
    claimed.add(row.card_id);
    matches.set(index, { row, matchedBy });
  };

  for (const [index, page] of pages.entries()) {
    claim(index, byPageId.get(page.pageId), 'page_id');
  }

  for (const [index, key] of keys.entries()) {
    claim(index, byIdentity.get(key), 'identity');
  }

  for (const [index, page] of pages.entries()) {
    if (matches.has(index)) continue;
    claim(
      index,
      (byPage.get(page.pageNumber) ?? []).find((candidate) => !claimed.has(candidate.card_id)),
      'page_number'
    );
  }

  const planned: PlannedPage[] = pages.map((page, index) => {
    const match = matches.get(index);
    return {
      pageNumber: page.pageNumber,
      title: page.title,
      cardId: match?.row.card_id ?? newId(),
      matchedBy: match?.matchedBy ?? null,
      identityKey: keys[index],
      sourcePageId: page.pageId,
      name: match?.row.filename ?? null,
    };
  });

  // The keys that will still be spoken for once this plan has been applied: a
  // card the plan did not claim keeps the key it has, and a card it did claim
  // gives that key up. Walked in page order, so the lowest-numbered page of a
  // repeated title is the one that keeps it and the rest take a key derived
  // from their own card id, which nothing else can hold.
  const taken = new Set(
    mapping.filter((row) => !claimed.has(row.card_id)).map((row) => row.identity_key)
  );
  for (const page of planned) {
    if (taken.has(page.identityKey)) page.identityKey = `p:${page.cardId}`;
    taken.add(page.identityKey);
  }
  return planned;
}

export function summarizePlan(planned: PlannedPage[], mapping: MappingRow[]): RunPlan {
  const claimed = new Set(planned.map((page) => page.cardId));
  const added = planned.filter((page) => page.matchedBy === null).length;
  return {
    added,
    updated: planned.length - added,
    removed: mapping
      .filter((row) => !claimed.has(row.card_id) && row.file_live)
      .map((row) => ({ file_id: row.file_id, name: row.filename })),
    pages: planned.map((page) => ({
      page_number: page.pageNumber,
      title: page.title,
      action: page.matchedBy === null ? 'add' : 'update',
      matched_by: page.matchedBy,
      name: page.name,
      is_back: isDeckBackTitle(page.title),
    })),
  };
}

// PUT /api/decks/:deckId/cards validates a whole list against the cap, and
// every other arrival checks it one row at a time: a deck the import has pushed
// past that bound is one the deck editor can never save again, because every
// hand edit then fails validation on a list the import wrote. Refused here
// rather than only at finish so a person learns it before uploading the export
// instead of after.
export async function assertPlanWithinCap(
  db: Connection,
  deckId: string,
  mapping: MappingRow[],
  planned: PlannedPage[]
): Promise<void> {
  const claimed = new Set(planned.map((page) => page.cardId));
  const additions =
    planned.filter((page) => page.matchedBy === null).length +
    mapping.filter((row) => claimed.has(row.card_id) && row.added_to_deck_at === null).length;
  const removals = mapping.filter(
    (row) => !claimed.has(row.card_id) && row.file_live && row.added_to_deck_at !== null
  ).length;

  const projected = (await countDeckCards(db, deckId)) - removals + additions;
  if (projected > MAX_DECK_CARDS) throw cardCapError(projected);
}
