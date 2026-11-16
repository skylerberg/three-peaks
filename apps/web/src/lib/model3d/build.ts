import { Group, Mesh, type BufferGeometry, type Material, type Shape } from 'three';
import {
  BOX_FACES,
  type BoardModelSettings,
  type BoxModelSettings,
  type CardModelSettings,
  type ModelKind,
  type ModelSettings,
  type PunchboardModelSettings,
  type WoodModelSettings,
} from '@three-peaks/shared';
import { buildBoardPanels } from './geometry/board.ts';
import { buildBoxGeometry } from './geometry/box.ts';
import { buildCardGeometry } from './geometry/card.ts';
import {
  EmptyPunchboardError,
  PUNCHBOARD_SHEET_NAME,
  buildSheetGeometry,
  buildTokenGeometry,
  punchboardLayout,
} from './geometry/punchboard.ts';
import { buildWoodGeometry } from './geometry/wood.ts';
import { boardMaterials } from './materials/board.ts';
import { boxMaterials } from './materials/box.ts';
import { cardMaterials } from './materials/cardStock.ts';
import { punchboardMaterials, type TokenFaces } from './materials/punchboard.ts';
import { woodMaterials } from './materials/wood.ts';
import {
  normalizeOutlines,
  outlineBounds,
  outlinesToShapes,
  ringsToOutlines,
} from './shapes/outlines.ts';
import { simplifyRing } from './shapes/simplify.ts';
import { svgOutlines } from './shapes/svg.ts';
import { traceRings } from './shapes/trace.ts';
import type { Bounds, Outline } from './shapes/types.ts';
import { sourceTexture, type SourceImage } from './sources.ts';

export class EmptyOutlineError extends Error {
  constructor() {
    super('Nothing was found to cut out. Try a lower threshold, or an image with a clear outline.');
    this.name = 'EmptyOutlineError';
  }
}

// What the exported node is called. A trailer scene holds several of these at
// once, so the name is the only thing telling one apart in an outliner.
const GROUP_NAMES: Record<ModelKind, string> = {
  card: 'Card',
  wood: 'Component',
  box: 'Box',
  board: 'Board',
  punchboard: 'Punchboard',
};

export class MissingArtworkError extends Error {
  constructor() {
    super('There is no artwork to build this from yet.');
    this.name = 'MissingArtworkError';
  }
}

// One of a punchboard's tokens, as the studio and the scene read it: both faces'
// images, and how many of it the sheet cuts.
export interface PunchboardTokenSource {
  front: SourceImage;
  back: SourceImage | null;
  quantity: number;
}

/**
 * The images a component is built from.
 *
 * One image for most kinds, and a card takes a second for its reverse; a
 * punchboard has no image of its own and is built from its tokens instead.
 * Named rather than positional because they are nothing alike, and a builder
 * handed the wrong one would extrude a card back.
 */
export interface ModelSources {
  artwork?: SourceImage | null;
  back?: SourceImage | null;
  tokens?: readonly PunchboardTokenSource[];
}

// One kind may be several meshes -- a folded board is one per panel -- and they
// share their materials, which is why the two lists are not the same length.
interface BuiltParts {
  meshes: Mesh[];
  materials: Material[];
}

interface Cut {
  outlines: Outline[];
  // Where the artwork sits in the same space the outlines came out in.
  frame: Bounds;
}

function woodOutlines(source: SourceImage, settings: WoodModelSettings): Cut {
  // A vector source already is an outline. Rasterising it only to trace the
  // raster back would throw away the exact edge and hand back a stepped one.
  if (source.svgText !== null) {
    // Its artwork is rasterised across the whole viewport, which nothing here
    // reads back; the paths' own bounds are the closest frame available.
    const outlines = svgOutlines(source.svgText);
    return { outlines, frame: outlineBounds(outlines) };
  }

  const rings = traceRings(source.pixels, {
    source: settings.trace_source,
    threshold: settings.trace_threshold,
  }).map((ring) => simplifyRing(ring, settings.simplify_tolerance));

  return {
    outlines: ringsToOutlines(rings.filter((ring) => ring.length >= 3)),
    frame: { minX: 0, minY: 0, maxX: source.pixels.width, maxY: source.pixels.height },
  };
}

function buildCard(
  settings: CardModelSettings,
  front: SourceImage,
  back: SourceImage | null
): BuiltParts {
  const geometry = buildCardGeometry(settings);
  const materials = cardMaterials(
    settings,
    sourceTexture(front),
    back ? sourceTexture(back) : null
  );
  const slots = [materials.front, materials.back, materials.rim];
  return { meshes: [new Mesh(geometry, slots)], materials: slots };
}

function buildWood(settings: WoodModelSettings, source: SourceImage): BuiltParts {
  const cut = woodOutlines(source, settings);
  const placed = normalizeOutlines(cut.outlines, cut.frame, {
    longestSideMm: settings.longest_side_mm,
    flipY: true,
  });
  if (placed.outlines.length === 0) throw new EmptyOutlineError();

  const shapes: Shape[] = outlinesToShapes(placed.outlines);
  const geometry = buildWoodGeometry(shapes, placed.frame, settings);

  // Printed pieces carry the artwork on both faces and bare wood on the cut
  // edge; unprinted ones are wood all the way round.
  const materials = woodMaterials(settings, settings.printed ? sourceTexture(source) : null);
  const slots = [materials.face, materials.face, materials.edge];
  return { meshes: [new Mesh(geometry, slots)], materials: slots };
}

function buildBox(settings: BoxModelSettings, source: SourceImage): BuiltParts {
  const geometry = buildBoxGeometry(settings);
  const materials = boxMaterials(settings, sourceTexture(source));
  // buildBoxGeometry numbers its groups by each face's place in BOX_FACES, so
  // reading the slots off the same list is what keeps the two in step.
  const slots = BOX_FACES.map((face) => materials.faces[face]);
  return { meshes: [new Mesh(geometry, slots)], materials: slots };
}

// What a punchboard part is called: its sheet, or one token on its own.
export const PUNCHBOARD_PARTS = { sheet: 'sheet', token: 'token' } as const;

/**
 * A punchboard is several meshes and the scene wants them as separate files, so
 * this builds the part it is asked for. `null` is the whole sheet with every
 * token in its hole, which is what the studio previews; `sheet` is the sheet
 * as its state says -- still holding its tokens, or the frame left after
 * punching; `token` is the one token it is handed, standing at the origin.
 */
function buildPunchboard(
  settings: PunchboardModelSettings,
  tokens: readonly PunchboardTokenSource[],
  part: string | null
): BuiltParts {
  if (part === PUNCHBOARD_PARTS.token) {
    const [only] = tokens;
    if (only === undefined) throw new EmptyPunchboardError();
    const layout = punchboardLayout(settings, []);
    const materials = punchboardMaterials(settings, [faces(only)]);
    const mesh = new Mesh(buildTokenGeometry(layout, settings), materials.tokens[0]);
    mesh.name = 'Token';
    return { meshes: [mesh], materials: materials.all };
  }

  const layout = punchboardLayout(
    settings,
    tokens.map((token) => token.quantity)
  );
  if (layout.pieces.length === 0) {
    throw new EmptyPunchboardError(
      tokens.length === 0
        ? undefined
        : 'Not one token fits on this sheet. Make the sheet larger, or the tokens or the margin smaller.'
    );
  }
  const materials = punchboardMaterials(settings, tokens.map(faces));
  const sheet = new Mesh(buildSheetGeometry(layout, settings), materials.sheet);
  sheet.name = PUNCHBOARD_SHEET_NAME;
  const meshes = [sheet];
  if (part === null || settings.sheet_state === 'intact') {
    // Every copy of a token is the same piece of board, so one geometry serves
    // them all.
    const geometry = buildTokenGeometry(layout, settings);
    for (const piece of layout.pieces) {
      const mesh = new Mesh(geometry, materials.tokens[piece.token]);
      mesh.name = piece.name;
      mesh.position.set(...piece.center);
      meshes.push(mesh);
    }
  }
  return { meshes, materials: materials.all };
}

function faces(token: PunchboardTokenSource): TokenFaces {
  return {
    front: sourceTexture(token.front),
    back: token.back === null ? null : sourceTexture(token.back),
  };
}

function buildBoard(settings: BoardModelSettings, source: SourceImage): BuiltParts {
  const materials = boardMaterials(settings, sourceTexture(source));
  const slots = [materials.face, materials.back, materials.edge];
  const meshes = buildBoardPanels(settings).map((panel) => {
    const mesh = new Mesh(panel.geometry, slots);
    mesh.name = panel.name;
    mesh.position.set(...panel.center);
    return mesh;
  });

  return { meshes, materials: slots };
}

export interface BuiltModel {
  group: Group;
  geometries: BufferGeometry[];
  materials: Material[];
}

function partsFor(settings: ModelSettings, sources: ModelSources, part: string | null): BuiltParts {
  if (settings.kind === 'punchboard') return buildPunchboard(settings, sources.tokens ?? [], part);
  const artwork = sources.artwork;
  if (!artwork) throw new MissingArtworkError();
  switch (settings.kind) {
    case 'card':
      return buildCard(settings, artwork, sources.back ?? null);
    case 'wood':
      return buildWood(settings, artwork);
    case 'box':
      return buildBox(settings, artwork);
    case 'board':
      return buildBoard(settings, artwork);
  }
}

/**
 * `part` names one piece of a component that has several -- a punchboard's
 * sheet or one of its tokens. Null builds the whole thing, which is what the
 * studio previews and what every other kind is regardless.
 */
export function buildModel(
  settings: ModelSettings,
  sources: ModelSources,
  part: string | null = null
): BuiltModel {
  const built = partsFor(settings, sources, part);

  const group = new Group();
  group.name = GROUP_NAMES[settings.kind];
  for (const mesh of built.meshes) group.add(mesh);

  return {
    group,
    geometries: built.meshes.map((mesh) => mesh.geometry),
    materials: built.materials,
  };
}

// A rebuild happens on every slider move, and neither geometry nor a texture is
// released by dropping the reference to it -- both hold GPU memory until they
// are told to let go.
export function disposeModel(model: BuiltModel): void {
  for (const geometry of new Set(model.geometries)) geometry.dispose();

  // A Set because the same material sits at two slots on a printed piece, the
  // same texture at two slots on a material, and one geometry under every copy
  // of a token.
  const seen = new Set<{ dispose(): void }>();
  for (const material of model.materials) {
    for (const value of Object.values(material)) {
      if (value && typeof value === 'object' && 'isTexture' in value) {
        seen.add(value as { dispose(): void });
      }
    }
    seen.add(material);
  }
  for (const disposable of seen) disposable.dispose();
}
