import {
  type CardSize,
  type FlipEdge,
  type Grid,
  type PageSize,
  type PrintRun,
  type Rect,
  TILE_BLEED_MM,
  type Tile,
  type TileSize,
  backPlacement,
  cutMarks,
  planSheets,
  planTileSheets,
  planTiles,
  slotBox,
  tileCutMarks,
  tileLabel,
} from '@three-peaks/shared';
import type { jsPDF } from 'jspdf';
import type { PrintImage } from './images.ts';

export type ArtworkFit = 'fill' | 'fit';

export interface PrintOptions {
  page: PageSize;
  printer_margin_mm: number;
  include_backs: boolean;
  flip: FlipEdge;
  cut_marks: boolean;
  fit: ArtworkFit;
}

// Resolves a file id to bytes. The caller owns the cache, so the same artwork
// asked for by twenty cards -- or by a front and a back -- is fetched and
// decoded once.
export interface ImageSource {
  artwork(fileId: string, card: CardSize): Promise<PrintImage>;
  board(fileId: string, size: TileSize): Promise<PrintImage>;
}

// Clockwise quarter turns a piece of artwork is drawn through on the page. One
// is the grid laying the card on its side; two more put a back upside down.
export type QuarterTurns = 0 | 1 | 2 | 3;

const CUT_MARK_LENGTH_MM = 3;
const CUT_MARK_WIDTH_MM = 0.15;
// Mid grey. Black trim guides are legible but also the first thing a hurried cut
// leaves a fragment of on the card.
const CUT_MARK_GREY = 150;

const TILE_LABEL_PT = 6;
// Clear of the corner mark it starts beside, and of the bleed it sits above.
const TILE_LABEL_INSET_MM = 1.5;
const TILE_LABEL_LIFT_MM = 0.8;

// Where a piece of artwork actually lands inside its slot.
//
// `fit` shows the whole image and leaves a margin on the axis that does not
// match -- which is what makes an artwork prepared at the wrong aspect ratio
// visible rather than silently trimmed. `fill` covers the slot and lets the
// overflow be clipped away, which is what artwork drawn to bleed expects.
export function placement(
  image: { width: number; height: number },
  box: Rect,
  fit: ArtworkFit
): Rect {
  const aspect = image.width / image.height;
  const boxAspect = box.width_mm / box.height_mm;
  const matchWidth = fit === 'fill' ? aspect < boxAspect : aspect > boxAspect;

  const width = matchWidth ? box.width_mm : box.height_mm * aspect;
  const height = matchWidth ? box.width_mm / aspect : box.height_mm;

  return {
    x_mm: box.x_mm + (box.width_mm - width) / 2,
    y_mm: box.y_mm + (box.height_mm - height) / 2,
    width_mm: width,
    height_mm: height,
  };
}

/**
 * The rectangle a piece of artwork covers on the page once it is turned.
 *
 * Fit and fill are decided in the card's own frame: a portrait image matches a
 * portrait card however the card lies on the paper. So a sideways turn compares
 * the image against the cell with its sides swapped and swaps the answer back.
 * The centre is the cell's either way.
 */
export function artworkRect(
  image: { width: number; height: number },
  box: Rect,
  fit: ArtworkFit,
  turns: QuarterTurns
): Rect {
  if (turns % 2 === 0) return placement(image, box, fit);

  const upright = placement(
    image,
    { ...box, width_mm: box.height_mm, height_mm: box.width_mm },
    fit
  );
  return {
    x_mm: box.x_mm + (box.width_mm - upright.height_mm) / 2,
    y_mm: box.y_mm + (box.height_mm - upright.width_mm) / 2,
    width_mm: upright.height_mm,
    height_mm: upright.width_mm,
  };
}

export interface ImageArgs extends Rect {
  // Degrees anticlockwise, which is the sense jsPDF's `rotation` takes.
  rotation: number;
}

/**
 * What `addImage` has to be handed for the artwork to cover `rect`, turned.
 *
 * jsPDF does not rotate about the centre of the box it is given. It translates
 * to that box's bottom-left corner, rotates by `rotation` degrees anticlockwise
 * and then scales the unit square by the width and height -- so the turned
 * image extends from that corner along wherever the turn has pointed its right
 * and its up. Each case below is that corner solved for the rectangle the
 * artwork should end up covering, with the artwork's own sides handed over as
 * the width and height, which a sideways turn swaps against the rectangle's.
 * `check:print` reads the result back out of a real file and holds this to the
 * library.
 */
export function imageArgs(rect: Rect, turns: QuarterTurns): ImageArgs {
  const { x_mm: x, y_mm: y, width_mm: w, height_mm: h } = rect;
  switch (turns) {
    case 0:
      return { x_mm: x, y_mm: y, width_mm: w, height_mm: h, rotation: 0 };
    // Pivot at the top-left corner: right goes down, up goes right.
    case 1:
      return { x_mm: x, y_mm: y - w, width_mm: h, height_mm: w, rotation: 270 };
    // Pivot at the top-right corner: right goes left, up goes down.
    case 2:
      return { x_mm: x + w, y_mm: y - h, width_mm: w, height_mm: h, rotation: 180 };
    // Pivot at the bottom-right corner: right goes up, up goes left.
    case 3:
      return { x_mm: x + w, y_mm: y + h - w, width_mm: h, height_mm: w, rotation: 90 };
  }
}

function upsideDown(turns: QuarterTurns): QuarterTurns {
  return ((turns + 2) % 4) as QuarterTurns;
}

// Inside a saved graphics state, which is what ends it. The `null` is the whole
// of this: a rectangle given no style is stroked, the stroke consumes the path,
// and the clip that follows then has nothing to intersect with -- so the
// artwork is drawn whole, with a hairline box where its edge was meant to be.
function clipTo(doc: jsPDF, rect: Rect): void {
  doc.rect(rect.x_mm, rect.y_mm, rect.width_mm, rect.height_mm, null);
  doc.clip();
  doc.discardPath();
}

function drawArtwork(
  doc: jsPDF,
  image: PrintImage,
  box: Rect,
  fit: ArtworkFit,
  alias: string,
  turns: QuarterTurns
): void {
  const rect = artworkRect(image, box, fit, turns);
  const overflows = rect.width_mm > box.width_mm + 1e-6 || rect.height_mm > box.height_mm + 1e-6;

  // Clipped rather than pre-cropped on a canvas: cropping would re-encode the
  // artwork, and re-encoding is what the pass-through in images.ts exists to
  // avoid. The clip costs four numbers in the content stream.
  if (overflows) {
    doc.saveGraphicsState();
    clipTo(doc, box);
  }

  // The alias is what stops the same artwork being embedded once per copy. With
  // a quantity of forty, that is the difference between a four-megabyte file and
  // a hundred-and-sixty-megabyte one. The turn lives in the placement, so one
  // embedding serves every orientation it is drawn at.
  const at = imageArgs(rect, turns);
  doc.addImage(
    image.data,
    image.format,
    at.x_mm,
    at.y_mm,
    at.width_mm,
    at.height_mm,
    alias,
    'FAST',
    at.rotation
  );

  if (overflows) doc.restoreGraphicsState();
}

function drawCutMarks(doc: jsPDF, options: PrintOptions, grid: Grid): void {
  doc.setDrawColor(CUT_MARK_GREY);
  doc.setLineWidth(CUT_MARK_WIDTH_MM);
  for (const mark of cutMarks(grid, options.page, CUT_MARK_LENGTH_MM)) {
    doc.line(mark.x1_mm, mark.y1_mm, mark.x2_mm, mark.y2_mm);
  }
}

export interface RenderProgress {
  drawn: number;
  total: number;
}

// jsPDF opens a document with one page already in it, so the first sheet of
// whatever is drawn first takes that one and every later sheet adds its own.
// One of these is shared by every pass over a document for that reason.
export function pageTurner(doc: jsPDF): () => void {
  let started = false;
  return () => {
    if (started) doc.addPage();
    started = true;
  };
}

/**
 * Draws every run into one document and returns the bytes.
 *
 * Pages come out front, back, front, back. A back page is emitted for **every**
 * front page whenever backs are asked for, even one on which no card has a back
 * and nothing is drawn: a duplex printer pairs sheet n's front with page 2n, and
 * skipping one blank page slides every later back onto the wrong front.
 *
 * `jsPDF` is imported by the caller and handed in, so this module can be unit
 * tested and so the library stays inside the chunk that only the print screen
 * loads.
 */
export async function renderRuns(
  doc: jsPDF,
  runs: readonly PrintRun[],
  options: PrintOptions,
  images: ImageSource,
  onProgress?: (progress: RenderProgress) => void,
  page: () => void = pageTurner(doc)
): Promise<void> {
  const plans = runs.map((run) => ({
    run,
    plan: planSheets(run.items, options.page, run.card, options.printer_margin_mm),
  }));

  const total = plans.reduce(
    (sum, entry) => sum + entry.plan.sheets.reduce((slots, sheet) => slots + sheet.slots.length, 0),
    0
  );
  let drawn = 0;

  for (const { run, plan } of plans) {
    if (plan.grid.per_sheet === 0) continue;
    // The grid's turn is the card's: a landscape cell holds a card on its side,
    // and drawing it upright at the cell's width is a band of its middle
    // eighteen times over.
    const turn: QuarterTurns = plan.grid.rotated ? 1 : 0;

    for (const sheet of plan.sheets) {
      page();
      for (const slot of sheet.slots) {
        const image = await images.artwork(slot.item.front_file_id, run.card);
        drawArtwork(doc, image, slot.box, options.fit, `art:${slot.item.front_file_id}`, turn);
        drawn += 1;
        onProgress?.({ drawn, total });
      }
      if (options.cut_marks) drawCutMarks(doc, options, plan.grid);

      if (!options.include_backs) continue;

      page();
      for (const slot of sheet.slots) {
        if (slot.item.back_file_id === null) continue;
        const onBack = backPlacement(slot.index, plan.grid, options.flip);
        const image = await images.artwork(slot.item.back_file_id, run.card);
        drawArtwork(
          doc,
          image,
          slotBox(plan.grid, onBack.index),
          options.fit,
          `art:${slot.item.back_file_id}`,
          onBack.rotate_180 ? upsideDown(turn) : turn
        );
      }
      if (options.cut_marks) drawCutMarks(doc, options, plan.grid);
    }
  }
}

// One board: its artwork, and the size it is cut to.
export interface PrintBoard extends TileSize {
  name: string;
  file_id: string;
}

// The standard fonts are WinAnsi and nothing else, and jsPDF writes a character
// outside it as two bytes of UTF-16 that the font then draws as two unrelated
// glyphs. A name is somebody's to choose, so what cannot be drawn is replaced
// rather than left to come out as noise in the margin of every sheet.
export function winAnsi(text: string): string {
  return text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

function drawTile(
  doc: jsPDF,
  image: PrintImage,
  tile: Tile,
  fit: ArtworkFit,
  alias: string,
  turns: QuarterTurns
): void {
  // Always clipped: what is handed to addImage is the whole board, placed so
  // that this tile's part of it falls on the sheet. That is what lets one
  // embedding serve every sheet the board is spread over.
  doc.saveGraphicsState();
  clipTo(doc, tile.inked);

  const at = imageArgs(artworkRect(image, tile.whole, fit, turns), turns);
  doc.addImage(
    image.data,
    image.format,
    at.x_mm,
    at.y_mm,
    at.width_mm,
    at.height_mm,
    alias,
    'FAST',
    at.rotation
  );

  doc.restoreGraphicsState();
}

function drawTileGuides(
  doc: jsPDF,
  options: PrintOptions,
  tile: Tile,
  label: string,
  bleedMm: number
): void {
  doc.setDrawColor(CUT_MARK_GREY);
  doc.setLineWidth(CUT_MARK_WIDTH_MM);
  for (const mark of tileCutMarks(tile, options.page, bleedMm)) {
    doc.line(mark.x1_mm, mark.y1_mm, mark.x2_mm, mark.y2_mm);
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(TILE_LABEL_PT);
  doc.setTextColor(CUT_MARK_GREY);
  doc.text(
    winAnsi(label),
    tile.cut.x_mm + TILE_LABEL_INSET_MM,
    tile.cut.y_mm - bleedMm - TILE_LABEL_LIFT_MM
  );
}

/**
 * Draws every board, one tile to a sheet, after whatever is already in the
 * document.
 *
 * A board is single-sided. `blankBacks` puts an empty page behind each tile,
 * which is what keeps them that way in a document a printer is turning over for
 * the card sheets ahead of them -- see `tilesWantBlankBacks`.
 *
 * The bleed goes with the marks. Without marks the edge of the ink is the only
 * thing saying where to cut, so ink that ran past the line would move it.
 */
export async function renderBoards(
  doc: jsPDF,
  boards: readonly PrintBoard[],
  options: PrintOptions,
  images: ImageSource,
  page: () => void,
  blankBacks: boolean,
  onProgress?: (drawn: number) => void
): Promise<void> {
  const bleed = options.cut_marks ? TILE_BLEED_MM : 0;
  let drawn = 0;

  for (const board of boards) {
    const grid = planTiles(options.page, board, options.printer_margin_mm);
    if (grid.pages === 0) continue;
    const turn: QuarterTurns = grid.rotated ? 1 : 0;
    const image = await images.board(board.file_id, board);

    for (const tile of planTileSheets(grid, options.page, bleed)) {
      page();
      drawTile(doc, image, tile, options.fit, `art:${board.file_id}`, turn);
      if (options.cut_marks) {
        drawTileGuides(doc, options, tile, tileLabel(board.name, grid, tile), bleed);
      }
      drawn += 1;
      onProgress?.(drawn);

      if (blankBacks) page();
    }
  }
}
