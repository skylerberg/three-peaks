import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINTER_MARGIN_MM, type Rect, pageSize } from './print.ts';
import {
  TILE_BLEED_MM,
  TILE_MARK_LENGTH_MM,
  planTileSheets,
  planTiles,
  summarizeTiles,
  tileCutMarks,
  tileLabel,
  tilesWantBlankBacks,
} from './tiles.ts';

const letter = pageSize('letter')!;
const margin = DEFAULT_PRINTER_MARGIN_MM;
// Letter inside the default margin: the room a tile's ink has. Written down
// rather than derived, so a change to the margin shows up here as a number.
const ROOM_WIDTH = 203.2;
const ROOM_HEIGHT = 266.7;

// Whether a rectangle lies where the printer can reach.
function insideMargin(rect: Rect): boolean {
  return (
    rect.x_mm >= margin - 1e-6 &&
    rect.y_mm >= margin - 1e-6 &&
    rect.x_mm + rect.width_mm <= letter.width_mm - margin + 1e-6 &&
    rect.y_mm + rect.height_mm <= letter.height_mm - margin + 1e-6
  );
}

describe('planTiles', () => {
  it('prints a board that fits the paper as one piece', () => {
    const grid = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin, true);
    expect(grid).toMatchObject({ columns: 1, rows: 1, pages: 1, rotated: false });
    expect(grid.tile_width_mm).toBe(150);
    expect(grid.tile_height_mm).toBe(200);
  });

  it('turns a board that only fits on its side', () => {
    const grid = planTiles(letter, { width_mm: 250, height_mm: 180 }, margin, true);
    expect(grid).toMatchObject({ columns: 1, rows: 1, pages: 1, rotated: true });
    expect(grid.tile_width_mm).toBe(180);
    expect(grid.tile_height_mm).toBe(250);
  });

  it('splits a board larger than the paper into equal tiles', () => {
    const grid = planTiles(letter, { width_mm: 500, height_mm: 500 }, margin, true);
    expect(grid).toMatchObject({ columns: 3, rows: 2, pages: 6, rotated: false });
    expect(grid.tile_width_mm).toBeCloseTo(500 / 3, 9);
    expect(grid.tile_height_mm).toBe(250);
  });

  // Three sheets upright, two on its side: the turn is worth a sheet here, and
  // a seam, which is one fewer strip of tape.
  it('turns a board when that takes fewer sheets', () => {
    const grid = planTiles(letter, { width_mm: 420, height_mm: 190 }, margin, true);
    expect(grid).toMatchObject({ columns: 1, rows: 2, pages: 2, rotated: true });
    expect(grid.tile_width_mm).toBe(190);
    expect(grid.tile_height_mm).toBe(210);
  });

  it('keeps a board upright when turning it saves nothing', () => {
    expect(planTiles(letter, { width_mm: 380, height_mm: 250 }, margin, true)).toMatchObject({
      columns: 2,
      rows: 1,
      rotated: false,
    });
  });

  // 10.5 in square, which is exactly Letter's printable height. With room kept
  // for its marks as well it went on four sheets, with a seam across the middle
  // that the paper never needed.
  it('gives a board the whole printable area, leaving its marks to the margin', () => {
    const grid = planTiles(letter, { width_mm: 266.7, height_mm: 266.7 }, margin, true);
    expect(grid).toMatchObject({ columns: 2, rows: 1, pages: 2, rotated: false });
    expect(grid.tile_width_mm).toBeCloseTo(133.35, 9);
    expect(grid.tile_height_mm).toBe(266.7);
  });

  // Including the largest tile each count allows, where the ink meets the
  // margin exactly and only centring the ink rather than the cut keeps it in.
  it('never inks a tile past the printer margin', () => {
    for (const size of [
      { width_mm: 50, height_mm: 50 },
      { width_mm: ROOM_WIDTH, height_mm: ROOM_HEIGHT },
      { width_mm: ROOM_WIDTH + 0.1, height_mm: ROOM_HEIGHT + 0.1 },
      { width_mm: (ROOM_WIDTH - TILE_BLEED_MM) * 2, height_mm: 10 },
      { width_mm: (ROOM_WIDTH - TILE_BLEED_MM * 2) * 3, height_mm: 10 },
      { width_mm: 266.7, height_mm: 266.7 },
      { width_mm: 600, height_mm: 400 },
      { width_mm: 1200, height_mm: 1200 },
    ]) {
      const grid = planTiles(letter, size, margin, true);
      for (const tile of planTileSheets(grid, letter)) expect(insideMargin(tile.inked)).toBe(true);
    }
  });

  // A sum a rounding error above the room is not a reason for one more sheet
  // holding a tile nothing wide.
  it('does not add a sheet for a board that fills the room exactly', () => {
    for (let columns = 1; columns <= 12; columns += 1) {
      const bleeds = Math.min(2, columns - 1);
      const width = (ROOM_WIDTH - TILE_BLEED_MM * bleeds) * columns;
      const grid = planTiles(letter, { width_mm: width, height_mm: 10 }, margin, true);
      // A strip this thin lies either way round; what matters is that neither
      // way has an extra tile in it.
      expect(grid.pages).toBeLessThanOrEqual(columns);
    }
  });

  // Without marks there is no bleed, so a board is split by its own size
  // alone: two millimetres a side is the difference between three columns and
  // two here.
  it('leaves room for a bleed only when there are marks to go with it', () => {
    const size = { width_mm: 404, height_mm: 404 };
    expect(planTiles(letter, size, margin, true)).toMatchObject({ pages: 6, bleed_mm: 2 });
    expect(planTiles(letter, size, margin, false)).toMatchObject({ pages: 4, bleed_mm: 0 });
  });

  it('gives a narrower printable area more sheets', () => {
    const size = { width_mm: 400, height_mm: 250 };
    expect(planTiles(letter, size, 0, true).pages).toBe(2);
    expect(planTiles(letter, size, 25, true).pages).toBe(4);
  });

  it('lays out nothing on paper its own margins fill', () => {
    const grid = planTiles(letter, { width_mm: 300, height_mm: 300 }, 200, true);
    expect(grid.pages).toBe(0);
    expect(planTileSheets(grid, letter)).toEqual([]);
  });
});

describe('planTileSheets', () => {
  const size = { width_mm: 560, height_mm: 420 };
  const grid = planTiles(letter, size, margin, true);
  const tiles = planTileSheets(grid, letter);

  it('lays the tiles out in reading order', () => {
    expect(grid).toMatchObject({ columns: 3, rows: 2 });
    expect(tiles.map((tile) => [tile.row, tile.column])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
  });

  it('centres every tile’s ink on its sheet', () => {
    for (const tile of tiles) {
      expect(tile.inked.x_mm + tile.inked.width_mm / 2).toBeCloseTo(letter.width_mm / 2, 9);
      expect(tile.inked.y_mm + tile.inked.height_mm / 2).toBeCloseTo(letter.height_mm / 2, 9);
    }
  });

  // The board as each sheet sees it: the tile's own cut, measured from the
  // corner of the whole, has to be its place in the grid -- or two tiles carry
  // the same strip of artwork and another strip is on none of them.
  it('gives each tile its own part of the board, and all of it between them', () => {
    const origins = tiles.map((tile) => ({
      x: tile.cut.x_mm - tile.whole.x_mm,
      y: tile.cut.y_mm - tile.whole.y_mm,
    }));

    for (const [index, origin] of origins.entries()) {
      expect(origin.x).toBeCloseTo(tiles[index].column * grid.tile_width_mm, 9);
      expect(origin.y).toBeCloseTo(tiles[index].row * grid.tile_height_mm, 9);
    }
    for (const tile of tiles) {
      expect(tile.whole.width_mm).toBeCloseTo(size.width_mm, 9);
      expect(tile.whole.height_mm).toBeCloseTo(size.height_mm, 9);
    }
    expect(grid.tile_width_mm * grid.columns).toBeCloseTo(size.width_mm, 9);
    expect(grid.tile_height_mm * grid.rows).toBeCloseTo(size.height_mm, 9);
  });

  it('lays a turned board out over its turned footprint', () => {
    const turned = planTiles(letter, { width_mm: 420, height_mm: 190 }, margin, true);
    const [first, second] = planTileSheets(turned, letter);
    expect(first.whole.width_mm).toBe(190);
    expect(first.whole.height_mm).toBe(420);
    expect(second.cut.y_mm - second.whole.y_mm).toBeCloseTo(210, 9);
  });

  it('inks past a cut only where another tile meets it', () => {
    const [topLeft, topMiddle, , , , bottomRight] = tiles;

    expect(topLeft.inked.x_mm).toBe(topLeft.cut.x_mm);
    expect(topLeft.inked.y_mm).toBe(topLeft.cut.y_mm);
    expect(topLeft.inked.width_mm).toBeCloseTo(topLeft.cut.width_mm + TILE_BLEED_MM, 9);
    expect(topLeft.inked.height_mm).toBeCloseTo(topLeft.cut.height_mm + TILE_BLEED_MM, 9);

    expect(topMiddle.inked.x_mm).toBeCloseTo(topMiddle.cut.x_mm - TILE_BLEED_MM, 9);
    expect(topMiddle.inked.width_mm).toBeCloseTo(topMiddle.cut.width_mm + TILE_BLEED_MM * 2, 9);

    expect(bottomRight.inked.x_mm).toBeCloseTo(bottomRight.cut.x_mm - TILE_BLEED_MM, 9);
    expect(bottomRight.inked.y_mm).toBeCloseTo(bottomRight.cut.y_mm - TILE_BLEED_MM, 9);
    expect(bottomRight.inked.width_mm).toBeCloseTo(bottomRight.cut.width_mm + TILE_BLEED_MM, 9);
    expect(bottomRight.inked.height_mm).toBeCloseTo(bottomRight.cut.height_mm + TILE_BLEED_MM, 9);
  });

  it('inks a board that is one piece to its own edge and no further', () => {
    const one = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin, true);
    const [tile] = planTileSheets(one, letter);
    expect(tile.inked).toEqual(tile.cut);
  });

  it('inks nothing past a cut when there are no marks', () => {
    const unmarked = planTiles(letter, size, margin, false);
    for (const tile of planTileSheets(unmarked, letter)) expect(tile.inked).toEqual(tile.cut);
  });
});

describe('tileCutMarks', () => {
  const grid = planTiles(letter, { width_mm: 560, height_mm: 420 }, margin, true);
  // Top middle: its top is the board's edge and its other three cuts are seams.
  const tile = planTileSheets(grid, letter)[1];
  const marks = tileCutMarks(tile, letter);
  const { x_mm: left, y_mm: top, width_mm: width, height_mm: height } = tile.cut;

  it('marks both ends of each of the four cuts', () => {
    expect(marks).toHaveLength(8);

    const vertical = marks.filter((mark) => mark.x1_mm === mark.x2_mm);
    const horizontal = marks.filter((mark) => mark.y1_mm === mark.y2_mm);
    expect(vertical.map((mark) => mark.x1_mm).sort()).toEqual(
      [left, left, left + width, left + width].sort()
    );
    expect(horizontal.map((mark) => mark.y1_mm).sort()).toEqual(
      [top, top, top + height, top + height].sort()
    );
  });

  // A mark drawn on the bleed is a mark under the ink, and one that starts
  // further out than the ink does is further into a margin it may not survive.
  it('starts every mark where the ink stops', () => {
    const { x_mm: inkLeft, y_mm: inkTop, width_mm: inkWidth, height_mm: inkHeight } = tile.inked;
    for (const mark of marks) {
      const vertical = mark.x1_mm === mark.x2_mm;
      const ends = vertical ? [mark.y1_mm, mark.y2_mm] : [mark.x1_mm, mark.x2_mm];
      const edges = vertical ? [inkTop, inkTop + inkHeight] : [inkLeft, inkLeft + inkWidth];

      expect(ends.filter((end) => edges.some((edge) => Math.abs(end - edge) < 1e-9))).toHaveLength(
        1
      );
      expect(Math.abs(ends[1] - ends[0])).toBeCloseTo(TILE_MARK_LENGTH_MM, 9);
    }
  });

  it('draws a mark against the cut on the board’s own edge, and past the bleed at a seam', () => {
    const above = marks.filter((mark) => mark.x1_mm === mark.x2_mm && mark.y2_mm <= top);
    expect(above.map((mark) => mark.y2_mm)).toEqual([top, top]);

    const beside = marks.filter((mark) => mark.y1_mm === mark.y2_mm && mark.x2_mm <= left);
    expect(beside.map((mark) => mark.x2_mm)).toEqual([left - TILE_BLEED_MM, left - TILE_BLEED_MM]);
  });

  // The seam down the middle of a board that fills the printable height: its
  // marks have nowhere to go but the margin, and are the only thing that says
  // where the seam is, since the artwork runs on past it.
  it('marks both ends of a seam that runs the full printable height', () => {
    const fills = planTiles(letter, { width_mm: 266.7, height_mm: 266.7 }, margin, true);
    const [leftHalf] = planTileSheets(fills, letter);
    const seam = leftHalf.cut.x_mm + leftHalf.cut.width_mm;
    const atSeam = tileCutMarks(leftHalf, letter).filter(
      (mark) => mark.x1_mm === seam && mark.x2_mm === seam
    );

    const expected = [
      [margin - TILE_MARK_LENGTH_MM, margin],
      [letter.height_mm - margin, letter.height_mm - margin + TILE_MARK_LENGTH_MM],
    ];
    expect(atSeam).toHaveLength(2);
    for (const [index, mark] of atSeam.entries()) {
      expect(mark.y1_mm).toBeCloseTo(expected[index][0], 9);
      expect(mark.y2_mm).toBeCloseTo(expected[index][1], 9);
    }
  });
});

describe('tileLabel', () => {
  it('names a tile by its row and column, and says how big it is', () => {
    const grid = planTiles(letter, { width_mm: 500, height_mm: 500 }, margin, true);
    const tiles = planTileSheets(grid, letter);
    expect(tileLabel('Main board', grid, tiles[4])).toBe(
      'Main board · row 2 of 2, column 2 of 3 · 166.7 × 250 mm'
    );
  });

  it('says only the size of a board that is one piece', () => {
    const grid = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin, true);
    expect(tileLabel('Player mat', grid, planTileSheets(grid, letter)[0])).toBe(
      'Player mat · 150 × 200 mm'
    );
  });
});

describe('tilesWantBlankBacks', () => {
  it('asks for none when nothing in the document has a back', () => {
    expect(tilesWantBlankBacks(true, 0)).toBe(false);
    expect(tilesWantBlankBacks(false, 4)).toBe(false);
  });

  it('asks for one behind every tile in a document with backing pages', () => {
    expect(tilesWantBlankBacks(true, 2)).toBe(true);
  });
});

describe('summarizeTiles', () => {
  const sizes = [
    { width_mm: 500, height_mm: 500 },
    { width_mm: 150, height_mm: 200 },
  ];

  it('counts the sheets every piece is spread over', () => {
    expect(summarizeTiles(sizes, letter, margin, true, false)).toEqual({
      pieces: 2,
      pages: 7,
      blank_pages: 0,
      unplaceable: false,
    });
  });

  it('counts a blank sheet behind each one when asked', () => {
    expect(summarizeTiles(sizes, letter, margin, true, true).blank_pages).toBe(7);
  });

  it('says so when a piece could not be laid out', () => {
    expect(summarizeTiles(sizes, letter, 200, true, false)).toMatchObject({
      pages: 0,
      unplaceable: true,
    });
  });
});
