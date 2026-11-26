import { describe, expect, it } from 'vitest';
import { CARD_PRESETS, cardPreset } from './cards.ts';
import {
  DEFAULT_PRINTER_MARGIN_MM,
  type PrintItem,
  backPlacement,
  cutMarks,
  effectiveDpi,
  expandCopies,
  pageSize,
  pixelsForPrint,
  planGrid,
  planRuns,
  planSheets,
  slotBox,
  summarizeRuns,
} from './print.ts';

const letter = pageSize('letter')!;
const poker = cardPreset('poker')!;
// A quarter inch, which is what a printer that cannot print borderless needs.
// Not the default, which is none: inside no margin at all, an assertion that
// something stays within it says only that it stays on the paper.
const margin = 6.35;

function item(front: string, back: string | null = null): PrintItem {
  return { front_file_id: front, back_file_id: back };
}

describe('planGrid', () => {
  // The number a designer plans a print run around. Each is the better of the
  // two orientations at the default printer margin, so a change to either the
  // default or the trial shows up here as a changed count rather than as a
  // stack of sheets nobody counts until it comes out of the printer.
  it.each([
    ['mini', 18, true],
    ['mini-square', 20, false],
    ['bridge', 9, false],
    ['euro', 9, false],
    ['poker', 9, false],
    ['square', 9, false],
    ['tarot', 6, false],
  ])('fits %s cards %i to a US Letter sheet', (id, expected, rotated) => {
    const grid = planGrid(letter, cardPreset(id)!, DEFAULT_PRINTER_MARGIN_MM);
    expect(grid.per_sheet).toBe(expected);
    expect(grid.rotated).toBe(rotated);
  });

  // The two sizes that pay for the rotation trial inside a quarter inch.
  // Without it mini loses six cards a sheet and euro two, and nothing else in
  // the suite would notice.
  it.each([
    ['mini', 12],
    ['euro', 6],
  ])('beats the upright-only layout for %s', (id, uprightOnly) => {
    const card = cardPreset(id)!;
    const usableWidth = letter.width_mm - margin * 2;
    const usableHeight = letter.height_mm - margin * 2;
    const upright =
      Math.floor(usableWidth / card.width_mm) * Math.floor(usableHeight / card.height_mm);

    expect(upright).toBe(uprightOnly);
    expect(planGrid(letter, card, margin).per_sheet).toBeGreaterThan(upright);
  });

  it('leaves the card upright when turning it gains nothing', () => {
    // 70 x 70 fits the same either way, and an unnecessary quarter turn makes a
    // proof harder to read before it is cut.
    expect(planGrid(letter, cardPreset('square')!, margin).rotated).toBe(false);
  });

  it('swaps the cell when it turns the card', () => {
    const mini = cardPreset('mini')!;
    const grid = planGrid(letter, mini, margin);
    expect(grid.cell_width_mm).toBe(mini.height_mm);
    expect(grid.cell_height_mm).toBe(mini.width_mm);
  });

  it.each(CARD_PRESETS)('centres the $id block inside the printer margin', (preset) => {
    const grid = planGrid(letter, preset, margin);
    const usedWidth = grid.columns * grid.cell_width_mm;
    const usedHeight = grid.rows * grid.cell_height_mm;

    expect(grid.origin_x_mm).toBeCloseTo((letter.width_mm - usedWidth) / 2, 6);
    expect(grid.origin_y_mm).toBeCloseTo((letter.height_mm - usedHeight) / 2, 6);
    expect(grid.origin_x_mm).toBeGreaterThanOrEqual(margin);
    expect(grid.origin_y_mm).toBeGreaterThanOrEqual(margin);
    expect(grid.origin_x_mm + usedWidth).toBeLessThanOrEqual(letter.width_mm - margin);
    expect(grid.origin_y_mm + usedHeight).toBeLessThanOrEqual(letter.height_mm - margin);
  });

  // The margin is a real cost, not a formality: without one a square card gains
  // half a sheet again, which is why the default is none.
  it.each([
    ['square', 6, 9],
    ['tarot', 4, 6],
    ['mini-square', 15, 20],
  ])('fits more %s cards once the printer margin is dropped', (id, guarded, borderless) => {
    const card = cardPreset(id)!;
    expect(planGrid(letter, card, margin).per_sheet).toBe(guarded);
    expect(planGrid(letter, card, 0).per_sheet).toBe(borderless);
  });

  it('reports nothing rather than dividing by zero when the card cannot fit', () => {
    const grid = planGrid(letter, { width_mm: 400, height_mm: 400 }, margin);
    expect(grid.per_sheet).toBe(0);
    expect(grid.columns).toBe(0);
    expect(grid.rows).toBe(0);
  });
});

describe('slotBox', () => {
  it('runs left to right, then top to bottom', () => {
    const grid = planGrid(letter, poker, margin);
    const first = slotBox(grid, 0);
    const second = slotBox(grid, 1);
    const nextRow = slotBox(grid, grid.columns);

    expect(second.y_mm).toBe(first.y_mm);
    expect(second.x_mm).toBeGreaterThan(first.x_mm);
    expect(nextRow.x_mm).toBe(first.x_mm);
    expect(nextRow.y_mm).toBeGreaterThan(first.y_mm);
  });

  it('butts neighbours edge to edge so a cut is shared', () => {
    const grid = planGrid(letter, poker, margin);
    const first = slotBox(grid, 0);
    expect(slotBox(grid, 1).x_mm).toBeCloseTo(first.x_mm + first.width_mm, 6);
    expect(slotBox(grid, grid.columns).y_mm).toBeCloseTo(first.y_mm + first.height_mm, 6);
  });
});

describe('backPlacement', () => {
  const grid = planGrid(letter, poker, margin);

  // The assertion that actually means something. Flipping the paper about its
  // vertical axis maps a point at x to one at pageWidth - x, so a back sits
  // behind its own front only when the two boxes are that reflection of each
  // other. A back page drawn without the mirror puts every card on the wrong
  // back and looks perfectly reasonable on screen.
  it('puts a long-edge back where the paper flip lands it', () => {
    for (let index = 0; index < grid.per_sheet; index += 1) {
      const front = slotBox(grid, index);
      const back = slotBox(grid, backPlacement(index, grid, 'long').index);

      expect(front.x_mm + back.x_mm + front.width_mm).toBeCloseTo(letter.width_mm, 6);
      expect(back.y_mm).toBeCloseTo(front.y_mm, 6);
    }
  });

  it('puts a short-edge back where that flip lands it, upside down', () => {
    for (let index = 0; index < grid.per_sheet; index += 1) {
      const front = slotBox(grid, index);
      const placement = backPlacement(index, grid, 'short');
      const back = slotBox(grid, placement.index);

      expect(front.y_mm + back.y_mm + front.height_mm).toBeCloseTo(letter.height_mm, 6);
      expect(back.x_mm).toBeCloseTo(front.x_mm, 6);
      expect(placement.rotate_180).toBe(true);
    }
  });

  it('leaves long-edge backs the right way up', () => {
    expect(backPlacement(0, grid, 'long').rotate_180).toBe(false);
  });

  // A turned card's top points across the page rather than up it, so the flip
  // that inverts it is the other one: long-edge reverses left and right, which
  // is now the axis its top lies along, and short-edge leaves that axis alone.
  describe('on a grid that turns the card', () => {
    const turned = planGrid(letter, cardPreset('mini')!, margin);

    it('draws a long-edge back upside down relative to its front on a turned grid', () => {
      expect(turned.rotated).toBe(true);
      for (let index = 0; index < turned.per_sheet; index += 1) {
        expect(backPlacement(index, turned, 'long').rotate_180).toBe(true);
      }
    });

    it('leaves a short-edge back turned the way its front is', () => {
      for (let index = 0; index < turned.per_sheet; index += 1) {
        expect(backPlacement(index, turned, 'short').rotate_180).toBe(false);
      }
    });

    // The paper flips the same way whatever is drawn in the cells, so the slot
    // a back lands in is the page's rule and does not move with the turn.
    it('still mirrors the slot the way the paper flips', () => {
      for (let index = 0; index < turned.per_sheet; index += 1) {
        const front = slotBox(turned, index);
        const long = slotBox(turned, backPlacement(index, turned, 'long').index);
        const short = slotBox(turned, backPlacement(index, turned, 'short').index);

        expect(front.x_mm + long.x_mm + front.width_mm).toBeCloseTo(letter.width_mm, 6);
        expect(long.y_mm).toBeCloseTo(front.y_mm, 6);
        expect(front.y_mm + short.y_mm + front.height_mm).toBeCloseTo(letter.height_mm, 6);
        expect(short.x_mm).toBeCloseTo(front.x_mm, 6);
      }
    });
  });

  it.each(['long', 'short'] as const)('is its own inverse on the %s edge', (flip) => {
    for (let index = 0; index < grid.per_sheet; index += 1) {
      expect(backPlacement(backPlacement(index, grid, flip).index, grid, flip).index).toBe(index);
    }
  });

  it('is a permutation of the sheet, so no slot is backed twice', () => {
    const landed = new Set<number>();
    for (let index = 0; index < grid.per_sheet; index += 1) {
      landed.add(backPlacement(index, grid, 'long').index);
    }
    expect(landed.size).toBe(grid.per_sheet);
  });
});

describe('expandCopies', () => {
  it('keeps copies of one card consecutive', () => {
    const expanded = expandCopies([
      { front_file_id: 'a', back_file_id: 'z', copies: 2 },
      { front_file_id: 'b', back_file_id: 'z', copies: 1 },
    ]);
    expect(expanded.map((entry) => entry.front_file_id)).toEqual(['a', 'a', 'b']);
  });

  it('drops a card asked for zero times', () => {
    expect(expandCopies([{ front_file_id: 'a', back_file_id: null, copies: 0 }])).toEqual([]);
  });
});

describe('planSheets', () => {
  it('fills each sheet before starting the next', () => {
    const grid = planGrid(letter, poker, margin);
    const items = Array.from({ length: grid.per_sheet + 2 }, (_value, index) =>
      item(`front-${index}`)
    );
    const plan = planSheets(items, letter, poker, margin);

    expect(plan.sheets).toHaveLength(2);
    expect(plan.sheets[0].slots).toHaveLength(grid.per_sheet);
    expect(plan.sheets[1].slots).toHaveLength(2);
  });

  // The whole reason a sheet resolves its backs per slot rather than per sheet.
  it('packs several decks onto one sheet, each card keeping its own back', () => {
    const items = [item('a1', 'back-a'), item('a2', 'back-a'), item('b1', 'back-b')];
    const [sheet] = planSheets(items, letter, poker, margin).sheets;

    expect(sheet.slots.map((slot) => slot.item.back_file_id)).toEqual([
      'back-a',
      'back-a',
      'back-b',
    ]);
  });

  it('gives a part-full last sheet only the slots it used', () => {
    const plan = planSheets([item('only')], letter, poker, margin);
    expect(plan.sheets).toHaveLength(1);
    expect(plan.sheets[0].slots).toHaveLength(1);
    expect(plan.sheets[0].slots[0].index).toBe(0);
  });

  it('plans no sheets for an empty run', () => {
    expect(planSheets([], letter, poker, margin).sheets).toEqual([]);
  });

  it('plans no sheets, and says why, for a card that does not fit', () => {
    const plan = planSheets([item('a')], letter, { width_mm: 400, height_mm: 400 }, margin);
    expect(plan.sheets).toEqual([]);
    expect(plan.grid.per_sheet).toBe(0);
  });
});

describe('cutMarks', () => {
  const grid = planGrid(letter, poker, margin);
  const marks = cutMarks(grid, letter);

  it('draws a pair of guides for every cut line', () => {
    expect(marks).toHaveLength((grid.columns + 1) * 2 + (grid.rows + 1) * 2);
  });

  // Without a margin a block can sit nearer the edge than a mark is long.
  it.each(CARD_PRESETS)('keeps every $id mark on the paper', (preset) => {
    for (const mark of cutMarks(planGrid(letter, preset, DEFAULT_PRINTER_MARGIN_MM), letter)) {
      for (const x of [mark.x1_mm, mark.x2_mm]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(letter.width_mm);
      }
      for (const y of [mark.y1_mm, mark.y2_mm]) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(letter.height_mm);
      }
    }
  });

  // A guide that crossed the block would be a line printed across the artwork.
  it('never reaches into the cards', () => {
    const top = grid.origin_y_mm;
    const bottom = top + grid.rows * grid.cell_height_mm;
    const left = grid.origin_x_mm;
    const right = left + grid.columns * grid.cell_width_mm;

    for (const mark of marks) {
      const insideX = mark.x1_mm > left && mark.x2_mm < right;
      const insideY = mark.y1_mm > top && mark.y2_mm < bottom;
      expect(insideX && insideY).toBe(false);
    }
  });

  it('draws none when nothing fits', () => {
    expect(cutMarks(planGrid(letter, { width_mm: 400, height_mm: 400 }, margin), letter)).toEqual(
      []
    );
  });
});

describe('resolution', () => {
  it('reads a 744 px front on a 63 mm card as 300 DPI', () => {
    expect(Math.round(effectiveDpi(744, 63))).toBe(300);
  });

  it('has no opinion about a zero-width card', () => {
    expect(effectiveDpi(744, 0)).toBe(0);
  });

  it('asks for enough pixels to print a tarot card at 300 DPI', () => {
    expect(pixelsForPrint(120)).toBe(1418);
  });

  it('never asks for less than one pixel', () => {
    expect(pixelsForPrint(0)).toBe(1);
  });
});

describe('planRuns', () => {
  const mini = cardPreset('mini')!;

  it('merges decks of one size into a single run', () => {
    const runs = planRuns([
      { card: poker, back_file_id: 'back-a', cards: [{ file_id: 'a1', copies: 1 }] },
      { card: poker, back_file_id: 'back-b', cards: [{ file_id: 'b1', copies: 1 }] },
    ]);

    expect(runs).toHaveLength(1);
    // Each card keeps the back of the deck it came from, which is what lets one
    // sheet hold several decks.
    expect(runs[0].items.map((item) => item.back_file_id)).toEqual(['back-a', 'back-b']);
  });

  // A punchboard's tokens each carry their own back: another image, their
  // front again, or nothing at all.
  it('prints a back a card names for itself in place of its set’s', () => {
    const token = { width_mm: 30, height_mm: 30 };
    const runs = planRuns([
      {
        card: token,
        back_file_id: null,
        cards: [
          { file_id: 'challenge', copies: 1, back_file_id: 'challenge-back' },
          { file_id: 'seeker', copies: 1, back_file_id: 'seeker' },
          { file_id: 'blank', copies: 1, back_file_id: null },
          { file_id: 'plain', copies: 1 },
        ],
      },
    ]);
    expect(runs[0].items.map((item) => item.back_file_id)).toEqual([
      'challenge-back',
      'seeker',
      null,
      null,
    ]);
  });

  it('starts a separate run for a different card size', () => {
    const runs = planRuns([
      { card: poker, back_file_id: null, cards: [{ file_id: 'a', copies: 1 }] },
      { card: mini, back_file_id: null, cards: [{ file_id: 'b', copies: 1 }] },
    ]);
    expect(runs).toHaveLength(2);
  });

  it('expands copy counts', () => {
    const runs = planRuns([
      { card: poker, back_file_id: null, cards: [{ file_id: 'a', copies: 3 }] },
    ]);
    expect(runs[0].items).toHaveLength(3);
  });

  it('drops a deck that contributes nothing', () => {
    expect(planRuns([{ card: poker, back_file_id: null, cards: [] }])).toEqual([]);
  });
});

describe('summarizeRuns', () => {
  it('counts a backing page for every front page', () => {
    const runs = planRuns([
      { card: poker, back_file_id: 'b', cards: [{ file_id: 'a', copies: 10 }] },
    ]);

    // Ten poker cards fill one sheet of nine and start a second.
    expect(summarizeRuns(runs, letter, margin, false)).toMatchObject({ cards: 10, sheets: 2 });
    expect(summarizeRuns(runs, letter, margin, true)).toMatchObject({ cards: 10, sheets: 4 });
  });

  it('reports cards that no sheet can hold rather than counting zero pages', () => {
    const runs = planRuns([
      {
        card: { width_mm: 400, height_mm: 400 },
        back_file_id: null,
        cards: [{ file_id: 'a', copies: 2 }],
      },
    ]);
    const summary = summarizeRuns(runs, letter, margin, true);

    expect(summary.oversized).toBe(true);
    expect(summary.cards).toBe(2);
    expect(summary.sheets).toBe(0);
  });

  it('says how many card sizes are in the run', () => {
    const runs = planRuns([
      { card: poker, back_file_id: null, cards: [{ file_id: 'a', copies: 1 }] },
      { card: cardPreset('tarot')!, back_file_id: null, cards: [{ file_id: 'b', copies: 1 }] },
    ]);
    expect(summarizeRuns(runs, letter, margin, false).sizes).toBe(2);
  });
});
