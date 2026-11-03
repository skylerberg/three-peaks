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
  // How far each tile is inked past a cut another tile meets.
  bleed_mm: number;
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
 * Only the ink has to fit inside the printer margin. The marks and the label
 * run out into it, as a card sheet's marks do: a 10.5 in board is exactly
 * Letter's printable height at the default margin, and reserving room for its
 * marks as well split it across four sheets rather than two.
 *
 * The bleed goes with the marks. Without marks the edge of the ink is the only
 * thing saying where to cut, so ink that ran past the line would move it.
 *
 * A piece that fits is one tile, which is why there is no separate path for a
 * board smaller than the paper. A sheet with no room inside its margins yields
 * `pages: 0`; callers check it before offering to print.
 */
export function planTiles(
  page: PageSize,
  size: TileSize,
  marginMm: number,
  cutMarks: boolean
): TileGrid {
  const bleed = cutMarks ? TILE_BLEED_MM : 0;
  const margin = Math.max(0, marginMm);
  const roomWidth = page.width_mm - margin * 2;
  const roomHeight = page.height_mm - margin * 2;

  // A tile's ink is its share of the piece and a bleed at every cut another
  // tile meets: none in one piece, one each in two, and two on every middle
  // tile after that. The epsilon is for a piece that fills the room exactly,
  // where a rounding error is not a reason for another sheet.
  const across = (length: number, room: number) => {
    if (length <= room + 1e-9) return 1;
    if (length / 2 + bleed <= room + 1e-9) return 2;
    return Math.ceil(length / (room - bleed * 2) - 1e-9);
  };
  const split = (width: number, height: number) => ({
    columns: across(width, roomWidth),
    rows: across(height, roomHeight),
  });

  if (
    roomWidth <= bleed * 2 ||
    roomHeight <= bleed * 2 ||
    size.width_mm <= 0 ||
    size.height_mm <= 0
  ) {
    return {
      columns: 0,
      rows: 0,
      pages: 0,
      rotated: false,
      bleed_mm: bleed,
      tile_width_mm: 0,
      tile_height_mm: 0,
    };
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
    bleed_mm: bleed,
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
export function planTileSheets(grid: TileGrid, page: PageSize): Tile[] {
  const { bleed_mm: bleed } = grid;

  return Array.from({ length: grid.pages }, (_unused, index) => {
    const row = Math.floor(index / grid.columns);
    const column = index % grid.columns;

    const before = { x: column > 0 ? bleed : 0, y: row > 0 ? bleed : 0 };
    const after = {
      x: column < grid.columns - 1 ? bleed : 0,
      y: row < grid.rows - 1 ? bleed : 0,
    };
    const inkedWidth = grid.tile_width_mm + before.x + after.x;
    const inkedHeight = grid.tile_height_mm + before.y + after.y;

    // The ink is centred rather than the cut: the bleed is on one side of an
    // end tile, and it is the ink that has to stay inside the margin.
    const inkedX = (page.width_mm - inkedWidth) / 2;
    const inkedY = (page.height_mm - inkedHeight) / 2;
    const x = inkedX + before.x;
    const y = inkedY + before.y;

    return {
      index,
      row,
      column,
      cut: { x_mm: x, y_mm: y, width_mm: grid.tile_width_mm, height_mm: grid.tile_height_mm },
      inked: { x_mm: inkedX, y_mm: inkedY, width_mm: inkedWidth, height_mm: inkedHeight },
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
// across two of them is the cut. Each starts where the ink stops, because ink
// that runs past the line would hide a mark drawn on it.
export function tileCutMarks(tile: Tile, page: PageSize): Segment[] {
  const { x_mm: x, y_mm: y, width_mm: width, height_mm: height } = tile.cut;
  return marksAround([x, x + width], [y, y + height], page, TILE_MARK_LENGTH_MM, tile.inked);
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
  cutMarks: boolean,
  blankBacks: boolean
): TileSummary {
  let pages = 0;
  let unplaceable = false;

  for (const size of sizes) {
    const grid = planTiles(page, size, marginMm, cutMarks);
    if (grid.pages === 0) unplaceable = true;
    pages += grid.pages;
  }

  return { pieces: sizes.length, pages, blank_pages: blankBacks ? pages : 0, unplaceable };
}
