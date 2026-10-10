import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINTER_MARGIN_MM, pageSize } from './print.ts';
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
// What a tile may measure on Letter inside the default margin, bleed and marks
// taken out. Written down rather than derived, so a change to either constant
// shows up here as a changed number.
const ROOM_WIDTH = 193.2;
const ROOM_HEIGHT = 256.7;

describe('planTiles', () => {
  it('prints a board that fits the paper as one piece', () => {
    const grid = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin);
    expect(grid).toMatchObject({ columns: 1, rows: 1, pages: 1, rotated: false });
    expect(grid.tile_width_mm).toBe(150);
    expect(grid.tile_height_mm).toBe(200);
  });

  it('turns a board that only fits on its side', () => {
    const grid = planTiles(letter, { width_mm: 250, height_mm: 180 }, margin);
    expect(grid).toMatchObject({ columns: 1, rows: 1, pages: 1, rotated: true });
    expect(grid.tile_width_mm).toBe(180);
    expect(grid.tile_height_mm).toBe(250);
  });

  it('splits a board larger than the paper into equal tiles', () => {
    const grid = planTiles(letter, { width_mm: 500, height_mm: 500 }, margin);
    expect(grid).toMatchObject({ columns: 3, rows: 2, pages: 6, rotated: false });
    expect(grid.tile_width_mm).toBeCloseTo(500 / 3, 9);
    expect(grid.tile_height_mm).toBe(250);
  });

  // Three sheets upright, two on its side: the turn is worth a sheet here, and
  // a seam, which is one fewer strip of tape.
  it('turns a board when that takes fewer sheets', () => {
    const grid = planTiles(letter, { width_mm: 420, height_mm: 190 }, margin);
    expect(grid).toMatchObject({ columns: 1, rows: 2, pages: 2, rotated: true });
    expect(grid.tile_width_mm).toBe(190);
    expect(grid.tile_height_mm).toBe(210);
  });

  it('keeps a board upright when turning it saves nothing', () => {
    expect(planTiles(letter, { width_mm: 380, height_mm: 250 }, margin)).toMatchObject({
      columns: 2,
      rows: 1,
      rotated: false,
    });
  });

  it('never makes a tile larger than the room the paper has', () => {
    for (const size of [
      { width_mm: 50, height_mm: 50 },
      { width_mm: 193.2, height_mm: 256.7 },
      { width_mm: 193.3, height_mm: 256.8 },
      { width_mm: 600, height_mm: 400 },
      { width_mm: 1200, height_mm: 1200 },
    ]) {
      const grid = planTiles(letter, size, margin);
      expect(grid.tile_width_mm).toBeLessThanOrEqual(ROOM_WIDTH + 1e-6);
      expect(grid.tile_height_mm).toBeLessThanOrEqual(ROOM_HEIGHT + 1e-6);
    }
  });

  // A quotient a rounding error above a whole number is not a reason for one
  // more sheet holding a tile nothing wide.
  it('does not add a sheet for a board that is an exact multiple of the room', () => {
    const room = letter.width_mm - (margin + TILE_BLEED_MM + TILE_MARK_LENGTH_MM) * 2;
    for (let columns = 1; columns <= 12; columns += 1) {
      const grid = planTiles(letter, { width_mm: room * columns, height_mm: 10 }, margin);
      // A strip this thin lies either way round; what matters is that neither
      // way has an extra tile in it.
      expect(grid.pages).toBeLessThanOrEqual(columns);
    }
  });

  it('gives a narrower printable area more sheets', () => {
    const size = { width_mm: 400, height_mm: 250 };
    expect(planTiles(letter, size, 0).pages).toBe(2);
    expect(planTiles(letter, size, 25).pages).toBe(4);
  });

  it('lays out nothing on paper its own margins fill', () => {
    const grid = planTiles(letter, { width_mm: 300, height_mm: 300 }, 200);
    expect(grid.pages).toBe(0);
    expect(planTileSheets(grid, letter)).toEqual([]);
  });
});

describe('planTileSheets', () => {
  const size = { width_mm: 500, height_mm: 400 };
  const grid = planTiles(letter, size, margin);
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

  it('centres every tile on its sheet', () => {
    for (const tile of tiles) {
      expect(tile.cut.x_mm + tile.cut.width_mm / 2).toBeCloseTo(letter.width_mm / 2, 9);
      expect(tile.cut.y_mm + tile.cut.height_mm / 2).toBeCloseTo(letter.height_mm / 2, 9);
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
    const turned = planTiles(letter, { width_mm: 420, height_mm: 190 }, margin);
    const [first, second] = planTileSheets(turned, letter);
    expect(first.whole.width_mm).toBe(190);
    expect(first.whole.height_mm).toBe(420);
    expect(second.cut.y_mm - second.whole.y_mm).toBe(210);
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
    const one = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin);
    const [tile] = planTileSheets(one, letter);
    expect(tile.inked).toEqual(tile.cut);
  });

  it('inks nothing past a cut when there is no bleed', () => {
    for (const tile of planTileSheets(grid, letter, 0)) expect(tile.inked).toEqual(tile.cut);
  });

  // The largest tile the planner will make, on every side at once: its bleed
  // and its marks both have to land where the printer can reach.
  it('keeps the bleed and the marks inside the printable area', () => {
    const full = planTiles(
      letter,
      { width_mm: ROOM_WIDTH * 3, height_mm: ROOM_HEIGHT * 3 },
      margin
    );
    expect(full).toMatchObject({ columns: 3, rows: 3 });
    const middle = planTileSheets(full, letter)[4];

    expect(middle.inked.x_mm).toBeGreaterThanOrEqual(margin - 1e-6);
    expect(middle.inked.y_mm).toBeGreaterThanOrEqual(margin - 1e-6);
    for (const mark of tileCutMarks(middle, letter)) {
      for (const x of [mark.x1_mm, mark.x2_mm]) {
        expect(x).toBeGreaterThanOrEqual(margin - 1e-6);
        expect(x).toBeLessThanOrEqual(letter.width_mm - margin + 1e-6);
      }
      for (const y of [mark.y1_mm, mark.y2_mm]) {
        expect(y).toBeGreaterThanOrEqual(margin - 1e-6);
        expect(y).toBeLessThanOrEqual(letter.height_mm - margin + 1e-6);
      }
    }
  });
});

describe('tileCutMarks', () => {
  const grid = planTiles(letter, { width_mm: 500, height_mm: 400 }, margin);
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

  // A mark drawn on the bleed is a mark under the ink.
  it('starts every mark clear of the bleed', () => {
    for (const mark of marks) {
      const vertical = mark.x1_mm === mark.x2_mm;
      const [near, far] = vertical ? [mark.y1_mm, mark.y2_mm] : [mark.x1_mm, mark.x2_mm];
      const [start, end] = vertical ? [top, top + height] : [left, left + width];
      const clearance = Math.min(...[near, far].map((at) => (at < start ? start - at : at - end)));

      expect(clearance).toBeCloseTo(TILE_BLEED_MM, 9);
      expect(Math.abs(far - near)).toBeCloseTo(TILE_MARK_LENGTH_MM, 9);
    }
  });

  it('draws the marks against the cut when there is no bleed to clear', () => {
    const flush = tileCutMarks(tile, letter, 0);
    expect(flush.some((mark) => mark.y2_mm === top)).toBe(true);
    expect(flush.some((mark) => mark.x2_mm === left)).toBe(true);
  });
});

describe('tileLabel', () => {
  it('names a tile by its row and column, and says how big it is', () => {
    const grid = planTiles(letter, { width_mm: 500, height_mm: 500 }, margin);
    const tiles = planTileSheets(grid, letter);
    expect(tileLabel('Main board', grid, tiles[4])).toBe(
      'Main board · row 2 of 2, column 2 of 3 · 166.7 × 250 mm'
    );
  });

  it('says only the size of a board that is one piece', () => {
    const grid = planTiles(letter, { width_mm: 150, height_mm: 200 }, margin);
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
    expect(summarizeTiles(sizes, letter, margin, false)).toEqual({
      pieces: 2,
      pages: 7,
      blank_pages: 0,
      unplaceable: false,
    });
  });

  it('counts a blank sheet behind each one when asked', () => {
    expect(summarizeTiles(sizes, letter, margin, true).blank_pages).toBe(7);
  });

  it('says so when a piece could not be laid out', () => {
    expect(summarizeTiles(sizes, letter, 200, false)).toMatchObject({
      pages: 0,
      unplaceable: true,
    });
  });
});
