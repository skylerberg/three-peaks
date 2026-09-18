import type { CardSize } from './cards.ts';

// The bounds a deck is held to, named once so the web app's inputs cannot offer
// a value the API rejects -- and so the numbers in the CHECK constraints have a
// counterpart a person can read.

export const DECK_NAME_LIMITS = [1, 120] as const;

// A copy count. Zero is a card the deck holds and prints none of -- artwork
// kept, in order, with its place in the list, and no piece of card behind it --
// which is a different thing from removing the row, and from deleting the
// image. Everything counting pieces rather than cards reads it: the sheets, the
// scene, and the deck's own "to print" total.
export const DECK_QUANTITY_LIMITS = [0, 999] as const;

// Well past a commercial deck, and low enough that one save is one request
// rather than a body nothing has bounded.
export const MAX_DECK_CARDS = 500;

// A deck names its size with the prefix its table column has. This is the one
// place that translation lives, so no screen re-spells it on its way into the
// preset lookup or the sheet planner.
export function deckCardSize(deck: { card_width_mm: number; card_height_mm: number }): CardSize {
  return { width_mm: deck.card_width_mm, height_mm: deck.card_height_mm };
}

// A card whose image is deleted keeps its row, its place and its copy count, so
// a restore lands where it was; until then it prints nothing and is drawn by no
// screen that is not asked for it.
export function isLiveCard(card: { file: { deleted_at: string | null } }): boolean {
  return card.file.deleted_at === null;
}

/**
 * The whole list a save sends, from the rows a screen drew and the deck it
 * drew them from. A save replaces the arrangement, so a row a screen is hiding
 * still has to be named: one left out loses its place and its copy count, and
 * a restore then brings it back at the end with one. Every hidden row keeps
 * the slot it holds in `held`, and the drawn rows fill the rest in the order
 * they were drawn -- anything drawn that `held` no longer has goes on the end.
 */
export function withHiddenCards<T extends { file_id: string }>(
  held: readonly T[],
  drawn: readonly T[]
): T[] {
  const shown = new Set(drawn.map((card) => card.file_id));
  const merged: T[] = [];
  let next = 0;
  for (const card of held) {
    if (!shown.has(card.file_id)) merged.push(card);
    else if (next < drawn.length) merged.push(drawn[next++]);
  }
  return [...merged, ...drawn.slice(next)];
}
