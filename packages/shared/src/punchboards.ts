// Where a punchboard's tokens sit on its sheet, and the die line that cuts
// them out. Pure, like `print.ts` beside it: it knows a sheet, a token's shape
// and how many copies of each token there are, and nothing about files.
//
// Every length is millimetres from the sheet's top-left corner as it is seen
// printed, the y axis running down the page.

import type { PunchboardModelSettings } from './models3d.ts';

// As many tokens as a deck holds cards, and for the same reason: well past a
// real punchboard, and low enough that one save is one bounded request. A
// token's copies are held to a card's, `DECK_QUANTITY_LIMITS`, zero included.
export const MAX_PUNCHBOARD_TOKENS = 500;

export interface TokenShape {
  width_mm: number;
  height_mm: number;
  // Never more than half the shorter side: past that the outline would cross
  // itself, and a radius dragged beyond it is a disc rather than an error.
  corner_radius_mm: number;
}

type SheetSettings = Pick<
  PunchboardModelSettings,
  | 'width_mm'
  | 'height_mm'
  | 'token_width_mm'
  | 'token_height_mm'
  | 'token_corner_radius_mm'
  | 'token_gap_mm'
  | 'margin_mm'
>;

export function tokenShape(settings: SheetSettings): TokenShape {
  const limit = Math.min(settings.token_width_mm, settings.token_height_mm) / 2;
  return {
    width_mm: settings.token_width_mm,
    height_mm: settings.token_height_mm,
    corner_radius_mm: Math.max(0, Math.min(settings.token_corner_radius_mm, limit)),
  };
}

// One token cut out of the sheet: which token of the punchboard's list it is a
// copy of, and the top-left corner of the box it is cut to.
export interface PunchboardSlot {
  token: number;
  copy: number;
  x_mm: number;
  y_mm: number;
}

export interface PunchboardPlan {
  columns: number;
  rows: number;
  // How many tokens the sheet can hold at all.
  capacity: number;
  // Every copy that fits, in the list's order and reading order on the sheet.
  slots: PunchboardSlot[];
  // The copies left over once the sheet is full, which nothing is drawn for.
  overflow: number;
}

// How many boxes of `length` with `gap` between them fit along `span`.
function fitting(span: number, length: number, gap: number): number {
  if (span < length) return 0;
  return Math.floor((span - length) / (length + gap) + 1e-9) + 1;
}

/**
 * The tokens packed onto the sheet in rows, each token's copies one after
 * another in the order the punchboard lists them.
 *
 * The block of tokens is centred inside the margin, so the frame is even all
 * round rather than heaped on the right and the bottom. A token is never
 * turned to fit: its artwork is drawn upright on the sheet, the way it is drawn
 * everywhere else.
 */
export function planPunchboard(
  settings: SheetSettings,
  quantities: readonly number[]
): PunchboardPlan {
  const shape = tokenShape(settings);
  const gap = settings.token_gap_mm;
  const columns = fitting(settings.width_mm - 2 * settings.margin_mm, shape.width_mm, gap);
  const rows = fitting(settings.height_mm - 2 * settings.margin_mm, shape.height_mm, gap);
  const capacity = columns * rows;

  const blockWidth = columns * shape.width_mm + Math.max(0, columns - 1) * gap;
  const blockHeight = rows * shape.height_mm + Math.max(0, rows - 1) * gap;
  const left = (settings.width_mm - blockWidth) / 2;
  const top = (settings.height_mm - blockHeight) / 2;

  const slots: PunchboardSlot[] = [];
  let wanted = 0;
  quantities.forEach((quantity, token) => {
    for (let copy = 0; copy < quantity; copy++) {
      wanted += 1;
      const index = slots.length;
      if (index >= capacity) continue;
      slots.push({
        token,
        copy,
        x_mm: left + (index % columns) * (shape.width_mm + gap),
        y_mm: top + Math.floor(index / columns) * (shape.height_mm + gap),
      });
    }
  });

  return { columns, rows, capacity, slots, overflow: wanted - slots.length };
}

/**
 * Where a token's back sits on the back of the sheet, as that side is seen
 * printed. Turning the sheet over left to right carries the left edge to the
 * right, so a back is mirrored across the sheet and drawn upright: what is
 * behind a token is its own back, the right way up once it is turned over.
 */
export function backSlotX(
  settings: Pick<SheetSettings, 'width_mm'>,
  slot: PunchboardSlot,
  shape: TokenShape
): number {
  return settings.width_mm - slot.x_mm - shape.width_mm;
}

// Four decimals of a millimetre, fixed, so one plan is always one string.
function n(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

// One token's outline at (x, y) as an SVG path: a rounded rectangle, which at
// the largest radius is a disc or a stadium.
export function tokenOutlinePath(shape: TokenShape, x: number, y: number): string {
  const { width_mm: w, height_mm: h } = shape;
  const r = shape.corner_radius_mm;
  if (r === 0) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  const arc = (dx: number, dy: number) => `a${n(r)} ${n(r)} 0 0 1 ${n(dx)} ${n(dy)}`;
  return [
    `M${n(x + r)} ${n(y)}`,
    `h${n(w - 2 * r)}`,
    arc(r, r),
    `v${n(h - 2 * r)}`,
    arc(-r, r),
    `h${n(-(w - 2 * r))}`,
    arc(-r, -r),
    `v${n(-(h - 2 * r))}`,
    arc(r, -r),
    'Z',
  ].join('');
}

/**
 * The die line: the sheet in millimetres with one closed path per token, as a
 * manufacturer's cutting file wants it -- a hairline stroke and no fill, every
 * token its own path so a token is one closed shape to any program reading it.
 */
export function punchboardDieLine(settings: SheetSettings, plan: PunchboardPlan): string {
  const shape = tokenShape(settings);
  const { width_mm: width, height_mm: height } = settings;
  const paths = plan.slots.map(
    (slot) => `<path d="${tokenOutlinePath(shape, slot.x_mm, slot.y_mm)}"/>`
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}">`,
    `<g fill="none" stroke="#ff0000" stroke-width="0.1">`,
    ...paths,
    '</g>',
    '</svg>',
  ].join('\n');
}
