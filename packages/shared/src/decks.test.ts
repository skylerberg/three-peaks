import { describe, expect, it } from 'vitest';
import { isLiveCard, withHiddenCards } from './decks.ts';

interface Row {
  file_id: string;
  quantity: number;
  file: { deleted_at: string | null };
}

function card(fileId: string, quantity: number, deleted = false): Row {
  return {
    file_id: fileId,
    quantity,
    file: { deleted_at: deleted ? '2026-09-01T00:00:00Z' : null },
  };
}

describe('isLiveCard', () => {
  it('is a card whose image is not deleted', () => {
    expect(isLiveCard(card('a', 1))).toBe(true);
    expect(isLiveCard(card('a', 1, true))).toBe(false);
  });
});

// What the deck editor saves while it is hiding some of the deck's rows. The
// save is the whole arrangement, so a row missing from it loses its place.
describe('withHiddenCards', () => {
  const ids = (list: readonly { file_id: string }[]) => list.map((entry) => entry.file_id);

  it('keeps a hidden card in its slot while the drawn ones are reordered around it', () => {
    const held = [card('a', 1), card('gone', 4), card('b', 1), card('c', 1)];
    const drawn = [card('c', 1), card('a', 1), card('b', 1)];

    const merged = withHiddenCards(held, drawn);

    expect(ids(merged)).toEqual(['c', 'gone', 'a', 'b']);
    expect(merged[1].quantity).toBe(4);
  });

  it('takes the drawn row over the held one, which is how a copy count reaches the save', () => {
    const held = [card('gone', 2), card('a', 1)];

    const merged = withHiddenCards(held, [card('a', 7)]);

    expect(merged.map((entry) => [entry.file_id, entry.quantity])).toEqual([
      ['gone', 2],
      ['a', 7],
    ]);
  });

  it('sends the drawn list as it is when nothing is hidden', () => {
    const held = [card('a', 1), card('b', 1)];
    expect(ids(withHiddenCards(held, [card('b', 1), card('a', 1)]))).toEqual(['b', 'a']);
  });

  // A card that arrived while a drag was live is in the deck and not in the
  // list the drop left; it keeps its place rather than being dropped.
  it('keeps a card the drawn list has not caught up with', () => {
    const held = [card('a', 1), card('b', 1), card('new', 1)];
    expect(ids(withHiddenCards(held, [card('b', 1), card('a', 1)]))).toEqual(['b', 'a', 'new']);
  });

  it('puts a drawn card the deck no longer holds on the end', () => {
    const held = [card('gone', 1), card('a', 1)];
    expect(ids(withHiddenCards(held, [card('a', 1), card('left', 1)]))).toEqual([
      'gone',
      'a',
      'left',
    ]);
  });
});
