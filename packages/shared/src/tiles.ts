// Splitting one piece too large for a sheet across several, to be cut out and
// taped back together.
//
// Pure geometry in millimetres, like print.ts and for the same reasons. Nothing
// here knows what a board is: it is handed a size and a sheet of paper.

import { type PageSize, type Rect, type Segment, marksAround } from './print.ts';

// How far the ink runs past a cut that another tile meets. A blade a hair
// outside the line then lands on artwork rather than on bare paper, which is
// the white hairline down the middle of a taped board.
export const TILE_BLEED_MM = 2;
export const TILE_MARK_LENGTH_MM = 3;
// The paper kept clear around a tile for both: the marks start where the bleed
// stops, so neither is ever drawn over the other.
const TILE_GUTTER_MM = TILE_BLEED_MM + TILE_MARK_LENGTH_MM;

export interface TileSize {
  width_mm: number;
  height_mm: number;
}

export interface TileGrid {
  columns: number;
  rows: number;
  pages: number;
  // Whether the piece lies a quarter turn round on the paper. The tile below
  // is its footprint after that turn, as `Grid.rotated` is for a card.
  rotated: boolean;
  tile_width_mm: number;
  tile_height_mm: number;
}

/**
 * How many sheets a piece is split across, and how big each part of it is.
 *
 * The tiles are equal rather than as many full sheets as fit plus a remainder:
 * a 420 mm board on Letter is then three pieces of 140 mm instead of two of
 * 193 and a sliver of 34 that has to be taped along both its long edges.
 *
 * The piece is tried turned as well as upright, and for the reason `planGrid`
 * gives -- turning the paper instead yields the same pair of answers, so every
 * page stays portrait. Ties go to upright.
 *
 * A piece that fits is one tile, which is why there is no separate path for a
 * board smaller than the paper. A sheet with no room inside its margins yields
 * `pages: 0`; callers check it before offering to print.
 */
export function planTiles(page: PageSize, size: TileSize, marginMm: number): TileGrid {
  const inset = Math.max(0, marginMm) + TILE_GUTTER_MM;
  const roomWidth = page.width_mm - inset * 2;
  const roomHeight = page.height_mm - inset * 2;

  // The epsilon is for a piece that is an exact multiple of the room: 386.4 mm
  // across 193.2 must be two tiles, and a quotient of 2.0000000000000004 is not
  // a reason for a third.
  const across = (length: number, room: number) => Math.max(1, Math.ceil(length / room - 1e-9));
  const split = (width: number, height: number) => ({
    columns: across(width, roomWidth),
    rows: across(height, roomHeight),
  });

  if (roomWidth <= 0 || roomHeight <= 0 || size.width_mm <= 0 || size.height_mm <= 0) {
    return { columns: 0, rows: 0, pages: 0, rotated: false, tile_width_mm: 0, tile_height_mm: 0 };
  }

  const upright = split(size.width_mm, size.height_mm);
  const turned = split(size.height_mm, size.width_mm);
  const rotated = turned.columns * turned.rows < upright.columns * upright.rows;

  const { columns, rows } = rotated ? turned : upright;
  return {
    columns,
    rows,
    pages: columns * rows,
    rotated,
    tile_width_mm: (rotated ? size.height_mm : size.width_mm) / columns,
    tile_height_mm: (rotated ? size.width_mm : size.height_mm) / rows,
  };
}

export interface Tile {
  index: number;
  row: number;
  column: number;
  // The piece that is cut out: its four sides are the four cuts.
  cut: Rect;
  // What is printed -- the cut, grown by the bleed on every side another tile
  // meets. An outer edge of the piece has nothing beyond it to bleed.
  inked: Rect;
  // Where the whole piece would lie on this sheet for this tile's part of it to
  // fall inside `cut`. Drawing the artwork there and clipping it to `inked` is
  // the whole of rendering a tile, so the artwork is embedded once however
  // many sheets it is spread over.
  whole: Rect;
}

// Tiles run left to right, top to bottom, which is the order they come out of
// the printer in and the order they are laid down in.
export function planTileSheets(grid: TileGrid, page: PageSize, bleedMm = TILE_BLEED_MM): Tile[] {
  const x = (page.width_mm - grid.tile_width_mm) / 2;
  const y = (page.height_mm - grid.tile_height_mm) / 2;

  return Array.from({ length: grid.pages }, (_unused, index) => {
    const row = Math.floor(index / grid.columns);
    const column = index % grid.columns;

    const before = { x: column > 0 ? bleedMm : 0, y: row > 0 ? bleedMm : 0 };
    const after = {
      x: column < grid.columns - 1 ? bleedMm : 0,
      y: row < grid.rows - 1 ? bleedMm : 0,
    };

    return {
      index,
      row,
      column,
      cut: { x_mm: x, y_mm: y, width_mm: grid.tile_width_mm, height_mm: grid.tile_height_mm },
      inked: {
        x_mm: x - before.x,
        y_mm: y - before.y,
        width_mm: grid.tile_width_mm + before.x + after.x,
        height_mm: grid.tile_height_mm + before.y + after.y,
      },
      whole: {
        x_mm: x - column * grid.tile_width_mm,
        y_mm: y - row * grid.tile_height_mm,
        width_mm: grid.tile_width_mm * grid.columns,
        height_mm: grid.tile_height_mm * grid.rows,
      },
    };
  });
}

// A mark at each end of each of a tile's four cuts, so a straightedge laid
// across two of them is the cut. They start clear of the bleed, which is what
// `bleedMm` is here: ink that runs to the line would hide a mark drawn on it.
export function tileCutMarks(tile: Tile, page: PageSize, bleedMm = TILE_BLEED_MM): Segment[] {
  const { x_mm: x, y_mm: y, width_mm: width, height_mm: height } = tile.cut;
  return marksAround([x, x + width], [y, y + height], page, TILE_MARK_LENGTH_MM, bleedMm);
}

function millimetres(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * What is printed in the margin beside a tile.
 *
 * The margin is cut away, so this is for the stack of sheets rather than the
 * finished board: which piece this is before the knife comes out. The size is
 * there for the other thing that goes wrong before then -- a print dialog left
 * on "fit to page" shrinks every piece, and a ruler against this number is the
 * only way to find out before taping them together.
 */
export function tileLabel(name: string, grid: TileGrid, tile: Tile): string {
  const size = `${millimetres(tile.cut.width_mm)} × ${millimetres(tile.cut.height_mm)} mm`;
  if (grid.pages <= 1) return `${name} · ${size}`;
  const place = `row ${tile.row + 1} of ${grid.rows}, column ${tile.column + 1} of ${grid.columns}`;
  return `${name} · ${place} · ${size}`;
}

/**
 * Whether each tile's sheet is followed by a blank one.
 *
 * A tiled piece is printed on one side. On its own that needs nothing, but in a
 * document that also carries card sheets with backing pages the whole job goes
 * through the printer double-sided, and the second tile would land on the back
 * of the first. `summarizeRuns` counts a backing page as a sheet, so
 * `cardSheets` is the number it reports.
 */
export function tilesWantBlankBacks(includeBacks: boolean, cardSheets: number): boolean {
  return includeBacks && cardSheets > 0;
}

export interface TileSummary {
  pieces: number;
  // Sheets with a tile on them. Blank ones are counted apart, because "a board
  // on six pages" is the number of pieces there are to cut.
  pages: number;
  blank_pages: number;
  // True when some piece could not be laid out at all, as `oversized` is for a
  // card: the one case that yields no pages for something that was asked for.
  unplaceable: boolean;
}

export function summarizeTiles(
  sizes: readonly TileSize[],
  page: PageSize,
  marginMm: number,
  blankBacks: boolean
): TileSummary {
  let pages = 0;
  let unplaceable = false;

  for (const size of sizes) {
    const grid = planTiles(page, size, marginMm);
    if (grid.pages === 0) unplaceable = true;
    pages += grid.pages;
  }

  return { pieces: sizes.length, pages, blank_pages: blankBacks ? pages : 0, unplaceable };
}
