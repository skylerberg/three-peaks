import { ExtrudeGeometry, type BufferGeometry, type Shape } from 'three';
import {
  planPunchboard,
  tokenShape,
  type PunchboardModelSettings,
  type PunchboardPlan,
} from '@three-peaks/shared';
import { roundedRectShape } from '../shapes/roundedRect.ts';
import { MM } from '../units.ts';
import { bevelledExtrusion } from './extrude.ts';
import { assignFaceGroups, remapCapUVs } from './faceGroups.ts';

export class EmptyPunchboardError extends Error {
  constructor(message = 'This punchboard has no tokens to cut yet.') {
    super(message);
    this.name = 'EmptyPunchboardError';
  }
}

// The sheet's own mesh. A token's is 'Token.001' upward, numbered in reading
// order from the top left and padded to three digits the way a board's panels
// are: once the bundle is in Blender the numbering is the only thing left
// saying which token came from where on the sheet.
export const PUNCHBOARD_SHEET_NAME = 'Sheet';

// Rounder than a card's corners need: a disc is the commonest token, and its
// whole outline is corner.
const CURVE_SEGMENTS = 24;

interface PunchboardPiece {
  name: string;
  // Where it sits in the sheet's plane, in metres.
  center: readonly [number, number, number];
  // Which token of the list it is a copy of.
  token: number;
}

export interface PunchboardLayout {
  plan: PunchboardPlan;
  width: number;
  height: number;
  // One token's size, in metres; every token is cut to it.
  token: { width: number; height: number; radius: number };
  pieces: PunchboardPiece[];
}

/**
 * Where everything on the sheet is, without building any geometry: the sheet's
 * own plan in metres, the y axis turned to point up the way the scene's does.
 *
 * Cheap on purpose: the scene exports the sheet and each token as a file of its
 * own, and extruding all of them once per file would be quadratic in the number
 * of tokens on the sheet.
 */
export function punchboardLayout(
  settings: PunchboardModelSettings,
  quantities: readonly number[]
): PunchboardLayout {
  const plan = planPunchboard(settings, quantities);
  const shape = tokenShape(settings);
  const width = settings.width_mm * MM;
  const height = settings.height_mm * MM;
  const token = {
    width: shape.width_mm * MM,
    height: shape.height_mm * MM,
    radius: shape.corner_radius_mm * MM,
  };
  const pieces = plan.slots.map((slot, index) => ({
    name: `Token.${String(index + 1).padStart(3, '0')}`,
    center: [
      -width / 2 + slot.x_mm * MM + token.width / 2,
      height / 2 - slot.y_mm * MM - token.height / 2,
      0,
    ] as const,
    token: slot.token,
  }));
  return { plan, width, height, token, pieces };
}

function extrude(shape: Shape, settings: PunchboardModelSettings): BufferGeometry {
  return new ExtrudeGeometry(shape, {
    ...bevelledExtrusion(settings.thickness_mm * MM, 0),
    curveSegments: CURVE_SEGMENTS,
  });
}

/**
 * One token, centred on the origin, its faces mapped to its own artwork: the
 * front's image runs edge to edge across the box the token is cut to, and the
 * back's, seen from behind, the same way round.
 */
export function buildTokenGeometry(layout: PunchboardLayout, settings: PunchboardModelSettings) {
  const { width, height, radius } = layout.token;
  const geometry = extrude(roundedRectShape(width, height, radius), settings);
  geometry.center();
  assignFaceGroups(geometry);
  remapCapUVs(geometry, { minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 });
  return geometry;
}

/**
 * The sheet as the die leaves it: square-cornered, guillotined like a mounted
 * board, with every token's outline cut through it. Whether the tokens are
 * still in their holes is a matter of which meshes stand beside it.
 */
export function buildSheetGeometry(layout: PunchboardLayout, settings: PunchboardModelSettings) {
  const sheet = roundedRectShape(layout.width, layout.height, 0);
  const { width, height, radius } = layout.token;
  sheet.holes = layout.pieces.map((piece) =>
    roundedRectShape(width, height, radius, { x: piece.center[0], y: piece.center[1] })
  );
  const geometry = extrude(sheet, settings);
  geometry.center();
  assignFaceGroups(geometry);
  const half = { x: layout.width / 2, y: layout.height / 2 };
  remapCapUVs(geometry, { minX: -half.x, minY: -half.y, maxX: half.x, maxY: half.y });
  return geometry;
}
