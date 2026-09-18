import { describe, expect, it } from 'vitest';
import { DECK_QUANTITY_LIMITS } from '@three-peaks/shared';
import {
  defaultCardModel,
  parseQuantity,
  safeFilename,
  shownCards,
  sizeFromOptions,
  sizeLabel,
} from '../../src/decks.ts';
import type { DeckCard } from '../../src/resolve.ts';

function card(id: string, deleted = false): DeckCard {
  return {
    file_id: id,
    quantity: 1,
    position: 0,
    file: {
      id,
      filename: `${id}.png`,
      deleted_at: deleted ? '2026-09-01T00:00:00.000Z' : null,
    } as DeckCard['file'],
  };
}

describe('shownCards', () => {
  it('hides cards whose image is deleted unless every row is asked for', () => {
    const held = [card('a'), card('x', true), card('b')];
    expect(shownCards(held, false).map((c) => c.file_id)).toEqual(['a', 'b']);
    expect(shownCards(held, true).map((c) => c.file_id)).toEqual(['a', 'x', 'b']);
  });
});

describe('parseQuantity', () => {
  const [min, max] = DECK_QUANTITY_LIMITS;

  it('accepts the whole range, zero included', () => {
    expect(parseQuantity(String(min))).toBe(min);
    expect(parseQuantity(String(max))).toBe(max);
  });

  it('refuses fractions, blanks and anything out of range', () => {
    for (const raw of ['1.5', '', ' ', 'two', String(max + 1), String(min - 1)]) {
      expect(() => parseQuantity(raw)).toThrow(/whole number/);
    }
  });
});

describe('sizeFromOptions', () => {
  it('reads a named size, case-insensitively', () => {
    expect(sizeFromOptions({ size: 'Tarot' })).toEqual({ width_mm: 70, height_mm: 120 });
  });

  it('reads explicit millimetres, either or both', () => {
    expect(sizeFromOptions({ width: '63.5', height: '88.9' })).toEqual({
      width_mm: 63.5,
      height_mm: 88.9,
    });
    expect(sizeFromOptions({ width: '60' })).toEqual({ width_mm: 60 });
    expect(sizeFromOptions({})).toBeUndefined();
  });

  it('refuses a named size and millimetres together, and an unknown size', () => {
    expect(() => sizeFromOptions({ size: 'poker', width: '60' })).toThrow(/not both/);
    expect(() => sizeFromOptions({ size: 'jumbo' })).toThrow(/No card size "jumbo"/);
    expect(() => sizeFromOptions({ height: '-3' })).toThrow(/millimetres/);
  });
});

describe('sizeLabel and defaultCardModel', () => {
  it('names a preset size and spells out any other', () => {
    expect(sizeLabel({ card_width_mm: 63, card_height_mm: 88 })).toBe('Poker (63 × 88 mm)');
    expect(sizeLabel({ card_width_mm: 60, card_height_mm: 90 })).toBe('60 × 90 mm');
  });

  it('sizes an undialled card to its deck', () => {
    const model = defaultCardModel({ card_width_mm: 70, card_height_mm: 120 });
    expect(model).toMatchObject({ kind: 'card', width_mm: 70, height_mm: 120 });
  });
});

describe('safeFilename', () => {
  it('keeps a filename from reaching outside the directory it is written into', () => {
    expect(safeFilename('ace.png')).toBe('ace.png');
    expect(safeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFilename('..')).toBe('_..');
    expect(safeFilename('a\\b.png')).toBe('a_b.png');
  });
});
