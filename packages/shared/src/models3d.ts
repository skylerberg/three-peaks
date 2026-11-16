// The dial-in for turning one uploaded image into one 3D component. Both sides
// need it: the API validates it, and the web app builds geometry from it.
//
// Every length is millimetres, because that is what a manufacturer's spec sheet
// is written in. The exporter is the only place that converts.

import { PANDA_CORNER_RADIUS_MM, cardPreset } from './cards.ts';

export const MODEL_KINDS = ['card', 'wood', 'box', 'board', 'punchboard'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export interface CardModelSettings {
  kind: 'card';
  width_mm: number;
  height_mm: number;
  thickness_mm: number;
  corner_radius_mm: number;
  bevel_mm: number;
  // The image on the reverse. Null prints back_color instead, which is what a
  // deck with an undesigned back looks like.
  back_file_id: string | null;
  back_color: string;
  stock_color: string;
  seed: number;
}

export interface WoodModelSettings {
  kind: 'wood';
  longest_side_mm: number;
  thickness_mm: number;
  bevel_mm: number;
  // Where the outline comes from. Alpha is right for a cutout PNG; luminance
  // traces dark-on-light artwork, which is the only option a JPEG leaves.
  trace_source: 'alpha' | 'luminance';
  trace_threshold: number;
  simplify_tolerance: number;
  // Whether the artwork is also printed on the faces, as a screen-printed
  // token, or whether the wood is left bare and only the outline is used.
  printed: boolean;
  wood_color: string;
  grain_color: string;
  grain_scale: number;
  seed: number;
}

// A box is textured from one flat wrap image -- a single unfolded net, laid out
// by boxNetRegions -- and that image is the row's own source file, so there is
// no second file id here and no per-face upload.
//
// It is a closed carton. An open one would need a wall thickness to line, which
// is a parameter this does not have and a seventh face group in the geometry.
export interface BoxModelSettings {
  kind: 'box';
  width_mm: number;
  height_mm: number;
  depth_mm: number;
  corner_bevel_mm: number;
  seed: number;
}

export const BOARD_FOLDS = ['none', 'bifold', 'quadfold'] as const;
export type BoardFold = (typeof BOARD_FOLDS)[number];

export interface BoardModelSettings {
  kind: 'board';
  width_mm: number;
  height_mm: number;
  thickness_mm: number;
  fold: BoardFold;
  // The gap the artwork leaves at a crease. A folded board is two or four
  // panels with a hinge, not one slab with a line drawn on it.
  fold_gap_mm: number;
  edge_color: string;
  seed: number;
}

export const PUNCHBOARD_SHEET_STATES = ['intact', 'punched'] as const;
export type PunchboardSheetState = (typeof PUNCHBOARD_SHEET_STATES)[number];

// A punchboard is a sheet of greyboard and the tokens die-cut from it. The
// tokens are its own (`component_token`), each a front and a back, and the
// sheet is laid out from them: every token is cut to the one shape below, and
// `planPunchboard` packs the copies onto the sheet in their order. Nothing
// about the sheet is uploaded or stored, so the printed sides and the die line
// are worked out from the tokens wherever they are needed and cannot fall
// behind them.
export interface PunchboardModelSettings {
  kind: 'punchboard';
  width_mm: number;
  height_mm: number;
  thickness_mm: number;
  // The box every token is cut to, and how round its corners are: a token is a
  // disc when the radius is half of both sides.
  token_width_mm: number;
  token_height_mm: number;
  token_corner_radius_mm: number;
  // Board left between two tokens, and between the sheet's edge and the
  // nearest of them -- the frame a die needs to hold the sheet together.
  token_gap_mm: number;
  margin_mm: number;
  // Whether the sheet mesh still holds its tokens, or has had them pushed out
  // and is the frame that is left.
  sheet_state: PunchboardSheetState;
  // Unprinted board: the reverse of a token with no back, the frame round the
  // tokens, and the edges the die cut leaves.
  back_color: string;
  edge_color: string;
  seed: number;
}

export type ModelSettings =
  | CardModelSettings
  | WoodModelSettings
  | BoxModelSettings
  | BoardModelSettings
  | PunchboardModelSettings;

export interface WoodPreset {
  id: string;
  name: string;
  thickness_mm: number;
}

export const WOOD_PRESETS: readonly WoodPreset[] = [
  { id: 'thin-ply', name: 'Thin ply (3 mm)', thickness_mm: 3 },
  { id: 'standard', name: 'Standard (8 mm)', thickness_mm: 8 },
  { id: 'thick', name: 'Thick (10 mm)', thickness_mm: 10 },
];

const DEFAULT_CARD_PRESET = cardPreset('poker');

export const DEFAULT_CARD_SETTINGS: CardModelSettings = {
  kind: 'card',
  width_mm: DEFAULT_CARD_PRESET?.width_mm ?? 63,
  height_mm: DEFAULT_CARD_PRESET?.height_mm ?? 88,
  // 300 gsm card stock, which is what most print houses default to.
  thickness_mm: 0.32,
  corner_radius_mm: PANDA_CORNER_RADIUS_MM,
  bevel_mm: 0.08,
  back_file_id: null,
  back_color: '#1f2933',
  stock_color: '#f5f2ea',
  seed: 1,
};

export const DEFAULT_WOOD_SETTINGS: WoodModelSettings = {
  kind: 'wood',
  longest_side_mm: 30,
  thickness_mm: 8,
  bevel_mm: 0.4,
  trace_source: 'alpha',
  trace_threshold: 0.5,
  simplify_tolerance: 1.2,
  printed: false,
  wood_color: '#c8a165',
  grain_color: '#8a6636',
  grain_scale: 4,
  seed: 1,
};

// A retail square box. Big enough to read as the game's own box in a trailer
// shot, which is the thing this kind exists to put on screen.
export const DEFAULT_BOX_SETTINGS: BoxModelSettings = {
  kind: 'box',
  width_mm: 295,
  height_mm: 295,
  depth_mm: 70,
  corner_bevel_mm: 1,
  seed: 1,
};

export const DEFAULT_BOARD_SETTINGS: BoardModelSettings = {
  kind: 'board',
  width_mm: 500,
  height_mm: 500,
  thickness_mm: 2,
  fold: 'bifold',
  fold_gap_mm: 3,
  edge_color: '#1f2933',
  seed: 1,
};

// A retail punchboard: the sheet a sprue of tokens is die-cut from, at the
// 2 mm greyboard most of them are made of, cutting inch-wide discs.
export const DEFAULT_PUNCHBOARD_SETTINGS: PunchboardModelSettings = {
  kind: 'punchboard',
  width_mm: 280,
  height_mm: 210,
  thickness_mm: 2,
  token_width_mm: 25,
  token_height_mm: 25,
  token_corner_radius_mm: 12.5,
  token_gap_mm: 3,
  margin_mm: 10,
  sheet_state: 'intact',
  back_color: '#b9ac93',
  edge_color: '#8d8069',
  seed: 1,
};

// Overloaded so a literal kind narrows: the caller that knows it asked for a
// card should not have to re-narrow the union it gets back.
export function defaultSettingsFor(kind: 'card'): CardModelSettings;
export function defaultSettingsFor(kind: 'wood'): WoodModelSettings;
export function defaultSettingsFor(kind: 'box'): BoxModelSettings;
export function defaultSettingsFor(kind: 'board'): BoardModelSettings;
export function defaultSettingsFor(kind: 'punchboard'): PunchboardModelSettings;
export function defaultSettingsFor(kind: ModelKind): ModelSettings;
export function defaultSettingsFor(kind: ModelKind): ModelSettings {
  switch (kind) {
    case 'card':
      return { ...DEFAULT_CARD_SETTINGS };
    case 'wood':
      return { ...DEFAULT_WOOD_SETTINGS };
    case 'box':
      return { ...DEFAULT_BOX_SETTINGS };
    case 'board':
      return { ...DEFAULT_BOARD_SETTINGS };
    case 'punchboard':
      return { ...DEFAULT_PUNCHBOARD_SETTINGS };
  }
}

// The bounds the API enforces, named once so the web app's number inputs cannot
// offer a value the server will reject.
export const MODEL_LIMITS = {
  card: {
    width_mm: [10, 300],
    height_mm: [10, 300],
    thickness_mm: [0.05, 5],
    corner_radius_mm: [0, 30],
    bevel_mm: [0, 2],
  },
  wood: {
    longest_side_mm: [5, 300],
    thickness_mm: [0.5, 50],
    bevel_mm: [0, 5],
    trace_threshold: [0.01, 0.99],
    simplify_tolerance: [0, 10],
    grain_scale: [0.1, 20],
  },
  box: {
    width_mm: [10, 600],
    height_mm: [10, 600],
    depth_mm: [5, 400],
    corner_bevel_mm: [0, 10],
  },
  board: {
    width_mm: [50, 1200],
    height_mm: [50, 1200],
    thickness_mm: [0.5, 12],
    fold_gap_mm: [0, 20],
  },
  punchboard: {
    width_mm: [50, 700],
    height_mm: [50, 700],
    thickness_mm: [0.5, 6],
    // The sizes a layout can be drawn at, so any token can be laid out.
    token_width_mm: [10, 300],
    token_height_mm: [10, 300],
    token_corner_radius_mm: [0, 150],
    token_gap_mm: [0, 50],
    margin_mm: [0, 100],
  },
} as const satisfies Record<ModelKind, Record<string, readonly [number, number]>>;

export const MAX_MODEL_SEED = 2147483647;

// A radius larger than half the shorter side is not a rounder card, it is a
// self-intersecting outline. Clamped rather than rejected, so dragging the
// slider past the limit stops instead of erroring.
export function clampCornerRadius(settings: CardModelSettings): number {
  const limit = Math.min(settings.width_mm, settings.height_mm) / 2;
  return Math.max(0, Math.min(settings.corner_radius_mm, limit));
}

export function woodPreset(id: string): WoodPreset | undefined {
  return WOOD_PRESETS.find((preset) => preset.id === id);
}

export function matchingWoodPreset(settings: WoodModelSettings): WoodPreset | undefined {
  return WOOD_PRESETS.find((preset) => preset.thickness_mm === settings.thickness_mm);
}

export const BOX_FACES = ['front', 'back', 'left', 'right', 'top', 'bottom'] as const;
export type BoxFace = (typeof BOX_FACES)[number];

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/**
 * Where each of the six faces sits on the one flat wrap image.
 *
 * The net is the printer's cross:
 *
 *           [ TOP    ]
 *   [ LEFT ][ FRONT  ][ RIGHT ][ BACK ]
 *           [ BOTTOM ]
 *
 * The image is assumed to be exactly (depth + width + depth + width) by
 * (depth + height + depth) in proportion. Nothing measures its pixels, so a
 * file drawn to other proportions samples the wrong rectangles rather than
 * failing -- which is why the guide the studio draws reads from here too.
 *
 * u runs left to right and v top to bottom: the image as stored, because the
 * studio exports textures with flipY off, so row 0 is v = 0.
 */
export function boxNetRegions(settings: BoxModelSettings): Record<BoxFace, UvRect> {
  const w = settings.width_mm;
  const h = settings.height_mm;
  const d = settings.depth_mm;
  const totalW = 2 * d + 2 * w;
  const totalH = 2 * d + h;
  const rect = (x0: number, y0: number, x1: number, y1: number): UvRect => ({
    u0: x0 / totalW,
    v0: y0 / totalH,
    u1: x1 / totalW,
    v1: y1 / totalH,
  });
  return {
    top: rect(d, 0, d + w, d),
    left: rect(0, d, d, d + h),
    front: rect(d, d, d + w, d + h),
    right: rect(d + w, d, 2 * d + w, d + h),
    back: rect(2 * d + w, d, 2 * d + 2 * w, d + h),
    bottom: rect(d, d + h, d + w, 2 * d + h),
  };
}
