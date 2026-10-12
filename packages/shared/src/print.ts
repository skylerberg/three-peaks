// Packing components onto sheets of paper, and working out where their backs go.
//
// Pure geometry: no DOM, no bytes, no library. Everything here is millimetres,
// because that is the unit the card sizes are quoted in and the unit the PDF
// writer is configured with, so there is no conversion anywhere to get wrong.
//
// The web app draws from this; a future token or tile printer should too, which
// is why nothing below knows what a deck is.

import type { CardSize } from './cards.ts';

export interface PageSize {
  id: string;
  name: string;
  width_mm: number;
  height_mm: number;
}

// Portrait, always. A landscape page is not a third layout -- see planGrid.
export const PAGE_SIZES: readonly PageSize[] = [
  { id: 'letter', name: 'US Letter (8.5 × 11 in)', width_mm: 215.9, height_mm: 279.4 },
];

export const DEFAULT_PAGE_SIZE_ID = 'letter';

// A quarter inch. Consumer printers refuse to put ink nearer the edge than
// roughly this, so packing to the paper rather than to the printable area is
// what produces a sheet whose outer row is clipped. Adjustable, because a
// borderless-capable printer can do better and the extra row is worth having.
export const DEFAULT_PRINTER_MARGIN_MM = 6.35;
export const PRINTER_MARGIN_LIMITS = [0, 25] as const;

// The industry print standard, and what a "this artwork is 180 DPI" warning is
// measured against.
export const PRINT_DPI = 300;

export function pageSize(id: string): PageSize | undefined {
  return PAGE_SIZES.find((page) => page.id === id);
}

export interface Grid {
  columns: number;
  rows: number;
  per_sheet: number;
  // Whether each card is turned a quarter turn on the page. The cell below is
  // its footprint after that turn, so nothing downstream has to un-swap it; the
  // renderer draws the artwork through the same turn, and backPlacement reads
  // it to decide which flip inverts a back.
  rotated: boolean;
  cell_width_mm: number;
  cell_height_mm: number;
  // Top-left of the grid on the page. The grid is centred, so this is at least
  // the printer margin.
  origin_x_mm: number;
  origin_y_mm: number;
}

/**
 * How many cards fit on one page, and where the block of them sits.
 *
 * Cards are butted edge to edge so neighbours share a cut, and the block is
 * centred inside the page inset by `marginMm` on all four sides.
 *
 * Two trials, not four: turning the page and turning the card produce the same
 * pair of products, because floor(A/w)·floor(B/h) is unchanged by writing the
 * factors in the other order. So a landscape page can never beat the better of
 * these two, and every page this emits is portrait.
 *
 * The turn is not a nicety. Mini goes 12 per sheet to 18 and euro 6 to 8.
 *
 * A card larger than the printable area yields `per_sheet: 0` rather than
 * throwing; callers check it before offering to print.
 */
export function planGrid(page: PageSize, card: CardSize, marginMm: number): Grid {
  const margin = Math.max(0, marginMm);
  const usableWidth = page.width_mm - margin * 2;
  const usableHeight = page.height_mm - margin * 2;

  const fit = (width: number, height: number) => {
    if (width <= 0 || height <= 0) return { columns: 0, rows: 0 };
    return {
      columns: Math.max(0, Math.floor(usableWidth / width)),
      rows: Math.max(0, Math.floor(usableHeight / height)),
    };
  };

  const upright = fit(card.width_mm, card.height_mm);
  const turned = fit(card.height_mm, card.width_mm);
  // Ties go to upright: same yield, and artwork the right way up on the page is
  // easier to check by eye before spending the ink.
  const rotated = turned.columns * turned.rows > upright.columns * upright.rows;

  const { columns, rows } = rotated ? turned : upright;
  const cellWidth = rotated ? card.height_mm : card.width_mm;
  const cellHeight = rotated ? card.width_mm : card.height_mm;

  return {
    columns,
    rows,
    per_sheet: columns * rows,
    rotated,
    cell_width_mm: cellWidth,
    cell_height_mm: cellHeight,
    origin_x_mm: (page.width_mm - columns * cellWidth) / 2,
    origin_y_mm: (page.height_mm - rows * cellHeight) / 2,
  };
}

// A rectangle on the page, measured from its top-left corner.
export interface Rect {
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
}

export interface SlotBox extends Rect {
  row: number;
  column: number;
}

// Slots run left to right, top to bottom, which is also the order a person
// reads a cut sheet in.
export function slotBox(grid: Grid, index: number): SlotBox {
  const row = Math.floor(index / grid.columns);
  const column = index % grid.columns;
  return {
    row,
    column,
    x_mm: grid.origin_x_mm + column * grid.cell_width_mm,
    y_mm: grid.origin_y_mm + row * grid.cell_height_mm,
    width_mm: grid.cell_width_mm,
    height_mm: grid.cell_height_mm,
  };
}

export type FlipEdge = 'long' | 'short';

export interface BackPlacement {
  index: number;
  // Whether the back is drawn upside down relative to its front -- on top of
  // the turn the grid gives both of them.
  rotate_180: boolean;
}

/**
 * Where a card's back goes on the sheet printed behind it.
 *
 * This is the whole duplex problem, and it is worth being explicit about why:
 * the printer flips the paper, and the flip is what mirrors the image. So the
 * back page is drawn as if read from the front, with the slots transposed --
 * mirroring the art as well would undo it and put every back on the wrong card.
 *
 * Every page is portrait, so the long edge is the tall one:
 *
 *  - `long` (the duplex default) turns the sheet about its vertical axis. Left
 *    and right swap; up stays up.
 *  - `short` turns it about its horizontal axis. Top and bottom swap.
 *
 * Whether the back is also drawn upside down depends on which way the card's
 * own top points. A back's top has to land on the physical edge the front's top
 * is on, and a flip reverses exactly one axis of the page: the short-edge flip
 * reverses up and down, which inverts an upright card, and the long-edge flip
 * reverses left and right, which inverts a card the grid has laid on its side.
 * Read as the upright rule alone, every back on a mini sheet arrives upside
 * down behind its front.
 *
 * A part-full last sheet needs no special case: only the slots that were used
 * are asked for.
 */
export function backPlacement(index: number, grid: Grid, flip: FlipEdge): BackPlacement {
  const row = Math.floor(index / grid.columns);
  const column = index % grid.columns;
  const rotate_180 = (flip === 'short') !== grid.rotated;

  if (flip === 'short') {
    return { index: (grid.rows - 1 - row) * grid.columns + column, rotate_180 };
  }
  return { index: row * grid.columns + (grid.columns - 1 - column), rotate_180 };
}

// One thing to print: the artwork, and what belongs on its reverse. A null back
// is a component printed single-sided.
export interface PrintItem {
  front_file_id: string;
  back_file_id: string | null;
}

export interface PrintRequestItem extends PrintItem {
  copies: number;
}

// Copies are consecutive rather than dealt round-robin: identical cards then
// come off the guillotine in one stack instead of scattered across the sheet.
export function expandCopies(items: readonly PrintRequestItem[]): PrintItem[] {
  const expanded: PrintItem[] = [];
  for (const item of items) {
    for (let copy = 0; copy < Math.max(0, Math.floor(item.copies)); copy += 1) {
      expanded.push({ front_file_id: item.front_file_id, back_file_id: item.back_file_id });
    }
  }
  return expanded;
}

// A run is everything of one card size that shares sheets.
export interface PrintRun {
  card: CardSize;
  items: PrintItem[];
}

export interface PlannedSlot {
  index: number;
  item: PrintItem;
  box: SlotBox;
}

export interface PlannedSheet {
  slots: PlannedSlot[];
}

export interface SheetPlan {
  grid: Grid;
  sheets: PlannedSheet[];
}

/**
 * Lays a run of components out over as few sheets as the grid allows.
 *
 * Items are placed in the order given and sheets are filled completely, so a
 * run drawn from several decks packs across the boundary between them. That is
 * deliberate: the back of each slot is resolved from that slot's own item, so a
 * sheet holding three decks still backs every card correctly.
 *
 * Yields no sheets at all when nothing fits; read `grid.per_sheet` to tell that
 * apart from an empty run.
 */
export function planSheets(
  items: readonly PrintItem[],
  page: PageSize,
  card: CardSize,
  marginMm: number
): SheetPlan {
  const grid = planGrid(page, card, marginMm);
  if (grid.per_sheet === 0) return { grid, sheets: [] };

  const sheets: PlannedSheet[] = [];
  for (let start = 0; start < items.length; start += grid.per_sheet) {
    const slots = items.slice(start, start + grid.per_sheet).map((item, index) => ({
      index,
      item,
      box: slotBox(grid, index),
    }));
    sheets.push({ slots });
  }
  return { grid, sheets };
}

export interface Segment {
  x1_mm: number;
  y1_mm: number;
  x2_mm: number;
  y2_mm: number;
}

/**
 * Trim guides for a block of cuts, drawn in the paper outside it.
 *
 * `xs` and `ys` are where the vertical and the horizontal cuts fall, outermost
 * first and last. They are marks in the margin rather than lines across the
 * sheet, because a line across the sheet is a line printed on the artwork. Each
 * starts `offsetMm` clear of the block and is clipped to the room actually
 * available, measured against the paper on each side rather than assumed
 * symmetric; one with no room is dropped rather than drawn where the printer
 * will not reach.
 */
export function marksAround(
  xs: readonly number[],
  ys: readonly number[],
  page: PageSize,
  lengthMm: number,
  offsetMm = 0
): Segment[] {
  if (xs.length === 0 || ys.length === 0) return [];

  const left = xs[0] - offsetMm;
  const right = xs[xs.length - 1] + offsetMm;
  const top = ys[0] - offsetMm;
  const bottom = ys[ys.length - 1] + offsetMm;

  const above = Math.min(lengthMm, top);
  const below = Math.min(lengthMm, page.height_mm - bottom);
  const toLeft = Math.min(lengthMm, left);
  const toRight = Math.min(lengthMm, page.width_mm - right);

  const segments: Segment[] = [];

  for (const x of xs) {
    if (above > 0) segments.push({ x1_mm: x, y1_mm: top - above, x2_mm: x, y2_mm: top });
    if (below > 0) segments.push({ x1_mm: x, y1_mm: bottom, x2_mm: x, y2_mm: bottom + below });
  }

  for (const y of ys) {
    if (toLeft > 0) segments.push({ x1_mm: left - toLeft, y1_mm: y, x2_mm: left, y2_mm: y });
    if (toRight > 0) segments.push({ x1_mm: right, y1_mm: y, x2_mm: right + toRight, y2_mm: y });
  }

  return segments;
}

// Every cut of a sheet of cards: one mark at each end of each grid line.
export function cutMarks(grid: Grid, page: PageSize, lengthMm = 3): Segment[] {
  if (grid.per_sheet === 0) return [];

  const xs = Array.from(
    { length: grid.columns + 1 },
    (_unused, column) => grid.origin_x_mm + column * grid.cell_width_mm
  );
  const ys = Array.from(
    { length: grid.rows + 1 },
    (_unused, row) => grid.origin_y_mm + row * grid.cell_height_mm
  );
  return marksAround(xs, ys, page, lengthMm);
}

// What a piece of artwork actually resolves to once it is printed at this size.
// The file rows already carry their pixel dimensions, so a screen can say "this
// is 180 DPI at 63 × 88 mm" without reading a single byte of the image.
export function effectiveDpi(pixels: number, lengthMm: number): number {
  if (lengthMm <= 0) return 0;
  return (pixels / lengthMm) * 25.4;
}

// The pixels a raster needs to hold up at print resolution, which is also the
// size a vector or an unsupported format is rasterised to.
export function pixelsForPrint(lengthMm: number, dpi: number = PRINT_DPI): number {
  return Math.max(1, Math.ceil((lengthMm / 25.4) * dpi));
}

// One component type's worth of a selection: a size, what goes on the back of
// everything in it, and the cards with their copy counts.
export interface PrintSource {
  card: CardSize;
  back_file_id: string | null;
  cards: readonly { file_id: string; copies: number }[];
}

/**
 * Groups a selection into runs that can each share sheets.
 *
 * Sources of one card size are merged into a single run and pack across the
 * boundary between them; a different size starts its own, because a grid holds
 * one cell size. The key is the millimetres rather than a preset id, so two
 * decks dialled in by hand to the same size still pack together.
 */
export function planRuns(sources: readonly PrintSource[]): PrintRun[] {
  const runs = new Map<string, PrintRun>();

  for (const source of sources) {
    const key = `${source.card.width_mm}x${source.card.height_mm}`;
    const run = runs.get(key) ?? { card: source.card, items: [] };
    run.items.push(
      ...expandCopies(
        source.cards.map((card) => ({
          front_file_id: card.file_id,
          back_file_id: source.back_file_id,
          copies: card.copies,
        }))
      )
    );
    runs.set(key, run);
  }

  return [...runs.values()].filter((run) => run.items.length > 0);
}

export interface RunSummary {
  cards: number;
  sheets: number;
  sizes: number;
  // True when some run holds a card larger than the printable area, which is
  // the one case that yields no sheets for cards that were nonetheless asked
  // for. A screen that only counted sheets would report zero and say nothing.
  oversized: boolean;
}

// What a screen shows before anyone spends ink, computed from the same planner
// the renderer walks -- so the sheet count on the button is the page count of
// the file it produces.
export function summarizeRuns(
  runs: readonly PrintRun[],
  page: PageSize,
  marginMm: number,
  includeBacks: boolean
): RunSummary {
  let cards = 0;
  let sheets = 0;
  let oversized = false;

  for (const run of runs) {
    cards += run.items.length;
    const grid = planGrid(page, run.card, marginMm);
    if (grid.per_sheet === 0) {
      oversized = true;
      continue;
    }
    const fronts = Math.ceil(run.items.length / grid.per_sheet);
    sheets += includeBacks ? fronts * 2 : fronts;
  }

  return { cards, sheets, sizes: runs.length, oversized };
}
